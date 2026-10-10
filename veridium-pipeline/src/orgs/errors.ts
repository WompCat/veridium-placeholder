/** Errors the org routes turn into HTTP responses. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const notFound = (message: string) => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);
export const unauthorized = (message = 'Log in to do that.') => new HttpError(401, message);
export const forbidden = (message: string) => new HttpError(403, message);
