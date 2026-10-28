import { describe, expect, it, vi } from 'vitest';
import { createS3Storage } from '../../lib/aws.js';

function fakeS3(behavior = () => ({})) {
  const command = (name) => class { constructor(input) { this.name = name; this.input = input; } };
  const sdk = { PutObjectCommand: command('Put'), GetObjectCommand: command('Get') };
  const client = { send: vi.fn(async (cmd) => behavior(cmd)) };
  return { sdk, client, load: async () => ({ client, sdk }) };
}
const s3Error = (name, status) => () => { throw Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } }); };

describe('S3 storage', () => {
  it('requires a bucket', () => {
    expect(() => createS3Storage({ bucket: '' })).toThrow(/INVOICES_BUCKET/);
  });

  it('puts objects with their content type', async () => {
    const { client, load } = fakeS3();
    await createS3Storage({ bucket: 'b', load }).put('invoices/j.pdf', new Uint8Array([1]), 'application/pdf');
    expect(client.send.mock.calls[0][0]).toMatchObject({ name: 'Put', input: { Bucket: 'b', Key: 'invoices/j.pdf', ContentType: 'application/pdf' } });
  });

  it('gets an object as bytes', async () => {
    const { client, load } = fakeS3(() => ({ Body: { transformToByteArray: async () => new Uint8Array([37, 80, 68, 70]) } }));
    expect(await createS3Storage({ bucket: 'b', load }).get('invoices/j.pdf')).toEqual(new Uint8Array([37, 80, 68, 70]));
    expect(client.send.mock.calls[0][0]).toMatchObject({ name: 'Get', input: { Bucket: 'b', Key: 'invoices/j.pdf' } });
  });

  it.each([['NoSuchKey', 404], ['NotFound', 404]])('returns null for a missing object (%s)', async (name, status) => {
    expect(await createS3Storage({ bucket: 'b', load: fakeS3(s3Error(name, status)).load }).get('k')).toBeNull();
  });

  it('treats a 403 as an error, not as missing (the role lacks s3:ListBucket)', async () => {
    await expect(createS3Storage({ bucket: 'b', load: fakeS3(s3Error('AccessDenied', 403)).load }).get('k')).rejects.toThrow('AccessDenied');
  });
});
