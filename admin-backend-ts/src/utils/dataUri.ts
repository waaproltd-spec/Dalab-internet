// Shared by any route accepting an uploaded image as a data URI in a JSON
// body (e.g. { imageBase64: "data:image/png;base64,...." }), parsed here into
// raw bytes + mime type rather than trusting a separate mimeType field from
// the client.
export function parseDataUri(dataUri: unknown): { data: Buffer; mimeType: string } | null {
  if (typeof dataUri !== "string") return null;
  const match = dataUri.match(/^data:([\w/+.-]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: Buffer.from(match[2], "base64") };
}
