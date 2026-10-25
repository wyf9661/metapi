import { z } from 'zod';

const authChangePayloadSchema = z.object({
  oldToken: z.string().optional(),
  newToken: z.string().optional(),
}).passthrough();

export type AuthChangePayload = z.output<typeof authChangePayloadSchema>;

function normalizeSupportRoutePayloadInput(input: unknown): unknown {
  return input === undefined ? {} : input;
}

function formatSupportRoutePayloadError(error: z.ZodError): string {
  const firstIssue = error.issues[0];
  const [firstPath] = firstIssue?.path ?? [];
  if (!firstPath) {
    return '请求体必须是对象';
  }
  if (firstPath === 'oldToken') {
    return 'Invalid oldToken. Expected string.';
  }
  if (firstPath === 'newToken') {
    return 'Invalid newToken. Expected string.';
  }
  return 'Invalid support route payload.';
}

function parseSupportRoutePayload<T extends z.ZodTypeAny>(
  schema: T,
  input: unknown,
): { success: true; data: z.output<T> } | { success: false; error: string } {
  const result = schema.safeParse(normalizeSupportRoutePayloadInput(input));
  if (!result.success) {
    return {
      success: false,
      error: formatSupportRoutePayloadError(result.error),
    };
  }
  return {
    success: true,
    data: result.data,
  };
}

export function parseAuthChangePayload(input: unknown):
{ success: true; data: AuthChangePayload } | { success: false; error: string } {
  return parseSupportRoutePayload(authChangePayloadSchema, input);
}
