/** errors.js — 统一错误类型与中文提示 */

export class CamToBgError extends Error {
  constructor(message, { code = 'EUNKNOWN', hint = '', cause } = {}) {
    super(message);
    this.name = 'CamToBgError';
    this.code = code;
    this.hint = hint;
    if (cause) this.cause = cause;
  }

  /** 面向终端用户的完整描述 */
  toUserMessage() {
    return this.hint ? `${this.message}\n提示：${this.hint}` : this.message;
  }
}

export const ErrorCodes = {
  BINARY_MISSING: 'EBINARYMISSING',
  DEVICE_BUSY: 'EDEVICEBUSY',
  NO_DEVICE: 'ENODEVICE',
  ENCODER_UNAVAILABLE: 'EENCODER',
  PIPELINE_FAILED: 'EPIPELINE',
  RENDER_FAILED: 'ERENDER',
  DESKTOP_ATTACH_FAILED: 'EDESKTOP',
  CONFIG_INVALID: 'ECONFIG',
  NOT_WINDOWS: 'EPLATFORM',
};