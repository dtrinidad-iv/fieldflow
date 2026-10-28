// AWS clients for deployed functions. The SDK v3 clients ship in the Lambda runtime (marked
// External in the esbuild metadata), so they're imported lazily and never in tests. One client per
// container, with short timeouts and one retry, so a stalled call ends well inside the function
// timeout with a proper error response.
const CLIENT_OPTIONS = { maxAttempts: 2, requestHandler: { connectionTimeout: 1000, requestTimeout: 3000 } };
let s3;
let dynamo;

async function s3Client() {
  const sdk = await import('@aws-sdk/client-s3');
  s3 ??= new sdk.S3Client(CLIENT_OPTIONS);
  return { client: s3, sdk };
}

// Invoice storage on S3. `load` is injectable so tests can check the request shapes and the
// missing-object handling without AWS.
export function createS3Storage({ bucket, load = s3Client }) {
  if (!bucket) throw new Error('INVOICES_BUCKET is not set');
  return {
    async put(key, bytes, contentType) {
      const { client, sdk } = await load();
      await client.send(new sdk.PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType }));
    },
    // The object's bytes, or null if there's none. S3 reports a missing key as 404 (NoSuchKey)
    // only to a role with s3:ListBucket on the bucket; otherwise it's a 403, which is an error.
    async get(key) {
      const { client, sdk } = await load();
      try {
        const { Body } = await client.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key }));
        return await Body.transformToByteArray();
      } catch (err) {
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },
  };
}

export async function dynamoClient() {
  const sdk = await import('@aws-sdk/client-dynamodb');
  dynamo ??= new sdk.DynamoDBClient(CLIENT_OPTIONS);
  return { client: dynamo, commands: sdk };
}
