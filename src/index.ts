// dsh-email package entry (public surface).
export { DshEmailPlugin } from './plugin.js'
export { default } from './plugin.js'
export { foldConfig } from './config.js'
export type { DeliveredAccountConfig, DeliveredConfig } from './config.js'
export type {
  AccountConfig,
  AddressView,
  AnalyzedMessage,
  AppendResult,
  AttachmentSpec,
  BodyView,
  EmailConfig,
  ErrorCode,
  ListMessage,
  PartView,
  SendRequest,
  SendResult,
  TlsEndpoint,
} from './types.js'
export { ERROR_CODES } from './types.js'
export {
  COMPACTION_RATIO,
  DEFAULT_OFFLOAD_BATCH,
  OFFLOAD_ARCHIVE_DIR,
  OFFLOAD_HOME_BASE,
  OFFLOAD_LOG_FILE,
  OFFLOAD_STORE_ROOT,
  SWEEP_PERIOD_MS,
  TREND_K,
  OffloadSweeper,
  appendRetentionEntry,
  parseEntryLine,
  parseWindowMs,
  readRetentionLog,
  rewriteRetentionLog,
} from './offload.js'
export type { InflightTracker, RetentionRecord, RetentionRecorder } from './watch.js'
