const QUEUE_NAMESPACE = process.env.APP_QUEUE_NAMESPACE || "meta-neon-matrix";

export const QUEUE_NAMES = Object.freeze({
  CSV_IMPORT_PREPARE: process.env.IMPORT_EDIT_QUEUE || `${QUEUE_NAMESPACE}-importEdit`,
  BULK_EDIT_EXECUTE: process.env.BULK_EDIT_EXECUTE_QUEUE || `${QUEUE_NAMESPACE}-bulk-edit-execute`,
});
