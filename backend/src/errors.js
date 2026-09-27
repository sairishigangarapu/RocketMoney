'use strict';
/* Typed HTTP errors. Services throw these; the HTTP layer maps statusCode -> response.
 * 404 (not 403) for non-members hides resource existence (EXP-007).
 */
class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}
const badRequest = (code, message) => new HttpError(400, code, message);
const unauthorized = (message = 'authentication required') => new HttpError(401, 'unauthorized', message);
const forbidden = (message = 'forbidden') => new HttpError(403, 'forbidden', message);
const notFound = (message = 'not found') => new HttpError(404, 'not-found', message);
const conflict = (code, message) => new HttpError(409, code, message);
const goneFrozen = () => new HttpError(409, 'room-frozen', 'room is frozen; writes rejected');

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict, goneFrozen };
