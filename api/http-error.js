// api/http-error.js
// Shared error helper so the storage layer and the route layer speak the same shape.

export function httpError(message, status = 400, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

export default httpError;
