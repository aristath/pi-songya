import { digest, recallOwners, type Config, type Reply } from "./client.ts";

export interface Message {
  role: string;
  timestamp?: number;
  content?: unknown;
  toolCallId?: string;
  customType?: string;
  stopReason?: string;
  [key: string]: unknown;
}
export interface Memory {
  id: string;
  content: string;
  retracted?: boolean;
  update?: boolean;
  [key: string]: unknown;
}
export interface Slot {
  anchor: string;
  source: string;
  memory: Memory;
}
export interface RecallState {
  scope: string;
  lastUser: string;
  slots: Slot[];
  notice: string;
}
export const RECALL_TYPE = "pi-songya:recollection";
export const GUIDE_TYPE = "pi-songya:guide";
export function plainText(message: Message): string {
  if (
    !["user", "assistant"].includes(message.role) ||
    ["error", "aborted"].includes(message.stopReason ?? "")
  )
    return "";
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}
export const anchorOf = (message: Message) =>
  digest([message.role, message.timestamp, message.toolCallId]);
export const sourceOf = (message: Message) =>
  digest([message.role, plainText(message)]);
export const scopeOf = (config: Config, _session: string) =>
  digest([
    config.store,
    config.config,
    config.user,
    config.agentUser ?? "agent",
  ]);
export const cleanMessages = (messages: Message[]) =>
  messages.filter(
    (m) =>
      m.role !== "custom" ||
      ![RECALL_TYPE, GUIDE_TYPE].includes(m.customType ?? ""),
  );
export function emptyState(scope: string): RecallState {
  return { scope, lastUser: "", slots: [], notice: "" };
}
export function restoreState(value: unknown, scope: string): RecallState {
  const state = value as RecallState;
  if (!state || state.scope !== scope || !Array.isArray(state.slots))
    return emptyState(scope);
  return {
    scope,
    lastUser: typeof state.lastUser === "string" ? state.lastUser : "",
    notice: typeof state.notice === "string" ? state.notice : "",
    slots: state.slots
      .filter(
        (slot) =>
          slot &&
          typeof slot.anchor === "string" &&
          typeof slot.source === "string" &&
          typeof slot.memory?.id === "string" &&
          typeof slot.memory?.content === "string",
      )
      .map((slot) => structuredClone(slot)),
  };
}
const memoryVersion = (m: Memory) =>
  digest([m.id, m.content, m.retracted === true]);
export function beforeRecall(
  state: RecallState,
  messages: Message[],
  sources: Message[],
): RecallState {
  const next = structuredClone(state);
  const sourceMap = new Map(
    sources.map((message) => [anchorOf(message), sourceOf(message)]),
  );
  next.slots = next.slots.filter(
    (slot) => sourceMap.get(slot.anchor) === slot.source,
  );
  const latestUser = messages.findLast((message) => message.role === "user");
  const user = latestUser
    ? digest([anchorOf(latestUser), sourceOf(latestUser)])
    : next.lastUser;
  if (next.lastUser && user !== next.lastUser) {
    const last = new Map<string, number>();
    next.slots.forEach((slot, index) => last.set(slot.memory.id, index));
    next.slots = next.slots
      .filter(
        (slot, index) =>
          last.get(slot.memory.id) === index && !slot.memory.retracted,
      )
      .map((slot) => ({
        ...slot,
        memory: Object.fromEntries(
          Object.entries(slot.memory).filter(([key]) => key !== "update"),
        ) as Memory,
      }));
  }
  next.lastUser = user;
  return next;
}
export function recallRequest(
  config: Config,
  messages: Message[],
  state: RecallState,
) {
  const eligible = messages
    .filter((message) => plainText(message) !== "")
    .toReversed();
  return {
    eligible,
    args: {
      messages: eligible.map(plainText),
      owners: recallOwners(config),
      known_ids: [...new Set(state.slots.map((slot) => slot.memory.id))],
    },
  };
}
export function applyRecall(
  state: RecallState,
  messages: Message[],
  eligible: Message[],
  reply: Reply,
): RecallState {
  const next = structuredClone(state);
  next.notice = "";
  if (reply.error) {
    next.notice = `Songya recall unavailable; previous recollections retained. ${reply.error}`;
    return next;
  }
  const results = reply.data?.results;
  if (
    !Array.isArray(results) ||
    results.length !== eligible.length ||
    results.some(
      (row) =>
        row?.mode !== "semantic" ||
        !["ready", "partial", "unavailable"].includes(row.status) ||
        typeof row.incomplete !== "boolean" ||
        !Array.isArray(row.items) ||
        row.items.some(
          (item: any) =>
            typeof item?.id !== "string" || typeof item.content !== "string",
        ),
    )
  ) {
    next.notice =
      "Songya returned incomplete recall data; previous recollections retained.";
    return next;
  }
  const fresh = new Map<string, { memory: Memory; message?: Message }>();
  for (let i = 0; i < results.length; i++) {
    const row = results[i];
    if (row.incomplete || row.status !== "ready")
      next.notice =
        "Songya recall incomplete; previous recollections retained.";
    for (const item of row.items as Memory[])
      if (!fresh.has(item.id))
        fresh.set(item.id, { memory: item, message: eligible[i] });
  }
  const knownStates = reply.data?.known;
  if (knownStates !== undefined && !Array.isArray(knownStates))
    next.notice =
      "Known recalled records could not be refreshed; previous recollections retained.";
  for (const known of Array.isArray(knownStates) ? knownStates : []) {
    if (
      known?.status === "current" &&
      known.item?.id === known.id &&
      typeof known.item.content === "string"
    )
      fresh.set(known.id, { memory: known.item });
    else if (
      ["missing", "retracted"].includes(known?.status) &&
      typeof known.id === "string"
    )
      fresh.set(known.id, {
        memory: { id: known.id, content: "", retracted: true },
      });
    else if (known?.status === "unknown")
      next.notice =
        "Some recalled records could not be refreshed; previous recollections retained.";
  }
  const previous = new Map(
    next.slots.map((slot) => [slot.memory.id, slot.memory]),
  );
  const carrier = messages.at(-1);
  if (!carrier) return next;
  for (const { memory, message } of fresh.values()) {
    const old = previous.get(memory.id);
    if (
      (old && memoryVersion(old) === memoryVersion(memory)) ||
      (!old && memory.retracted)
    )
      continue;
    const target = state.slots.length === 0 && message ? message : carrier;
    const copy = structuredClone(memory);
    if (old) copy.update = true;
    next.slots.push({
      anchor: anchorOf(target),
      source: sourceOf(target),
      memory: copy,
    });
    previous.set(memory.id, copy);
  }
  return next;
}
export function projectRecall(
  messages: Message[],
  state: RecallState,
): Message[] {
  const out: Message[] = [];
  const anchors = new Set(messages.map(anchorOf));
  const block = (slot: Slot): Message => ({
    role: "custom",
    customType: RECALL_TYPE,
    display: false,
    timestamp: 0,
    content: `<songya_recollection>\n${JSON.stringify(slot.memory.retracted ? { id: slot.memory.id, retracted: true } : { id: slot.memory.id, text: slot.memory.content, ...(slot.memory.update ? { update: true } : {}) }).replaceAll("<", "\\u003c")}\n</songya_recollection>`,
  });
  // Compaction can remove an anchor from the active window. Its surviving
  // recollections remain available, ahead of the retained conversation.
  for (const slot of state.slots)
    if (!anchors.has(slot.anchor)) out.push(block(slot));
  for (const message of messages) {
    out.push(message);
    for (const slot of state.slots)
      if (slot.anchor === anchorOf(message)) out.push(block(slot));
  }
  if (state.notice)
    out.push({
      role: "custom",
      customType: RECALL_TYPE,
      display: false,
      timestamp: 0,
      content: `<songya_status>${JSON.stringify({ notice: state.notice }).replaceAll("<", "\\u003c")}</songya_status>`,
    });
  return out;
}

// A correction and its earlier versions travel together. If a whole record will
// not fit, omit that record rather than presenting a known obsolete version.
export function fitRecall(
  state: RecallState,
  budget: number,
  cost: (message: Message) => number,
) {
  const groups = new Map<string, Slot[]>();
  for (const slot of state.slots)
    groups.set(slot.memory.id, [...(groups.get(slot.memory.id) ?? []), slot]);
  const kept = new Set<string>();
  let remaining = Math.max(0, budget);
  for (const [id, slots] of groups) {
    const size = projectRecall([], { ...state, slots, notice: "" }).reduce(
      (sum, message) => sum + cost(message),
      0,
    );
    if (size <= remaining) {
      kept.add(id);
      remaining -= size;
    }
  }
  const selected = {
    ...state,
    slots: state.slots.filter((slot) => kept.has(slot.memory.id)),
  };
  const omitted = groups.size - kept.size;
  const notice = [
    state.notice,
    omitted
      ? `${omitted} recalled record(s) omitted to fit this model request. Search Songya directly for more detail.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const noticeCost = projectRecall([], { ...state, slots: [], notice }).reduce(
    (sum, message) => sum + cost(message),
    0,
  );
  selected.notice = notice && noticeCost <= remaining ? notice : "";
  return { state: selected, omitted };
}
