/**
 * Port for sending callbacks to clients.
 *
 * @interface ICallbackSender
 * @method send(callbackUrl, payload, callbackMeta) → void
 *
 * @param {string} callbackUrl - client's webhook URL
 * @param {Object} payload - { type, taskId, ...data }
 * @param {Object} [callbackMeta] - opaque JSONB passed through to client
 */
export class ICallbackSender {
  async send(_callbackUrl, _payload, _callbackMeta) {
    throw new Error('Not implemented');
  }
}
