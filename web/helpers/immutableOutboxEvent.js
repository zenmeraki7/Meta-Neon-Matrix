import { buildImmutablePayloadMetadata } from "../utils/immutablePayloadUtils.js";

export function hashOutboxPayload(payload) {
  return buildImmutablePayloadMetadata({ payload, operationType: "OUTBOX_EVENT" }).payloadHash;
}

export function immutableOutboxEvent(data) {
  const eventDedupeKey = String(data?.eventDedupeKey || "").trim();
  if (!eventDedupeKey) throw new Error("OUTBOX_EVENT_DEDUPE_REQUIRED");
  if (eventDedupeKey.length > 512) throw new Error("OUTBOX_EVENT_DEDUPE_TOO_LONG");
  return {
    ...data,
    eventDedupeKey,
    ...buildImmutablePayloadMetadata({ payload: data?.payloadJson, operationType: "OUTBOX_EVENT" }),
    statusNormalized: data?.statusNormalized || "PENDING",
  };
}
