// Deploy safety for template.yaml and samconfig.toml, checked on every test run:
// - stored data is never deleted or replaced by a deploy (Retain policies, pinned logical ids)
// - least-privilege IAM, timeouts, log retention, API throttling
// - every deploy section shows the changeset first
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// CloudFormation short-form tags (!Ref, !Sub, ...) as their long form ({ Ref: ... }).
const INTRINSICS = ['Ref', 'Condition', 'Base64', 'Cidr', 'FindInMap', 'GetAtt', 'GetAZs', 'ImportValue',
  'Join', 'Select', 'Split', 'Sub', 'Transform', 'And', 'Equals', 'If', 'Not', 'Or'];
const longName = (name) => (name === 'Ref' || name === 'Condition' ? name : `Fn::${name}`);
const customTags = INTRINSICS.flatMap((name) => [
  { tag: `!${name}`, resolve: (value) => ({ [longName(name)]: name === 'GetAtt' ? value.split('.') : value }) },
  { tag: `!${name}`, collection: 'seq', resolve: (seq) => ({ [longName(name)]: seq.toJSON() }) },
]);

const template = parse(readFileSync(path.join(root, 'template.yaml'), 'utf8'), { customTags });
const resources = Object.entries(template.Resources);
const ofType = (...types) => resources.filter(([, r]) => types.includes(r.Type));

// Resource types that hold data a deploy must never delete or replace.
const STATEFUL_TYPES = [
  'AWS::S3::Bucket', 'AWS::DynamoDB::Table', 'AWS::DynamoDB::GlobalTable', 'AWS::Serverless::SimpleTable',
  'AWS::Logs::LogGroup', 'AWS::SSM::Parameter', 'AWS::SecretsManager::Secret', 'AWS::KMS::Key', 'AWS::SQS::Queue',
  'AWS::Kinesis::Stream', 'AWS::ECR::Repository', 'AWS::RDS::DBInstance', 'AWS::RDS::DBCluster',
  'AWS::EFS::FileSystem', 'AWS::Cognito::UserPool',
];
// Types known to hold no data. Any type on neither list fails, so a new kind of resource gets a
// deliberate decision instead of silently skipping the data-safety checks.
const STATELESS_TYPES = [
  'AWS::Serverless::Function', 'AWS::Serverless::HttpApi', 'AWS::Serverless::Api', 'AWS::Serverless::LayerVersion',
  'AWS::Lambda::Function', 'AWS::Lambda::Permission', 'AWS::Lambda::LayerVersion', 'AWS::IAM::Role',
  'AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy', 'AWS::Events::Rule', 'AWS::Scheduler::Schedule',
  'AWS::CloudWatch::Alarm', 'AWS::SNS::Topic', 'AWS::SNS::Subscription',
];

// Every stateful resource, pinned with the properties that force a replacement. The file is
// append-only and the protect-files hook asks the user before any edit to it, so renaming a
// resource (which makes CloudFormation delete it) can't be "fixed" by editing the test alongside.
const PINNED = JSON.parse(readFileSync(path.join(root, 'tests/infra/stateful-resources.json'), 'utf8')).resources;

describe('template.yaml: data safety', () => {
  it.each(ofType(...STATEFUL_TYPES))('%s keeps its data on delete and on replacement', (_, resource) => {
    expect(['Retain', 'RetainExceptOnCreate']).toContain(resource.DeletionPolicy);
    expect(resource.UpdateReplacePolicy).toBe('Retain');
  });

  it.each(Object.entries(PINNED))('still has %s with the same type and replacement-forcing properties', (id, pin) => {
    expect(template.Resources[id]?.Type).toBe(pin.Type);
    for (const [prop, value] of Object.entries(pin.Replacement)) {
      expect(template.Resources[id].Properties?.[prop], `${id}.${prop}`).toEqual(value);
    }
  });

  it('pins every stateful resource, so a rename or removal is caught', () => {
    const stateful = ofType(...STATEFUL_TYPES).map(([id]) => id).sort();
    expect(stateful).toEqual(Object.keys(PINNED).sort());
  });

  it('knows whether every resource type holds data', () => {
    const unknown = resources.filter(([, r]) => !STATEFUL_TYPES.includes(r.Type) && !STATELESS_TYPES.includes(r.Type));
    expect(unknown.map(([id, r]) => `${id} (${r.Type})`)).toEqual([]);
  });
});

describe('template.yaml: IAM and secrets', () => {
  const statements = resources.flatMap(([id, r]) => {
    const docs = [
      ...(r.Type === 'AWS::Serverless::Function' ? [r.Properties?.Policies].flat().filter((p) => p?.Statement) : []),
      ...(r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy' ? [r.Properties.PolicyDocument] : []),
      ...(r.Type === 'AWS::IAM::Role' ? (r.Properties.Policies ?? []).map((p) => p.PolicyDocument) : []),
    ];
    return docs.flatMap((doc) => [doc.Statement].flat().map((s) => [id, s]));
  });

  it('has no wildcard actions or resources, and no NotAction / NotResource', () => {
    for (const [id, s] of statements) {
      expect(s.NotAction, `${id} NotAction`).toBeUndefined();
      expect(s.NotResource, `${id} NotResource`).toBeUndefined();
      for (const action of [s.Action].flat()) expect(action, `${id} action`).not.toMatch(/\*/);
      for (const resource of [s.Resource].flat()) {
        if (typeof resource === 'string') expect(resource, `${id} resource`).not.toMatch(/^\*$|:\*$/);
      }
    }
  });

  it('gives functions only SAM policy templates or scoped statements, never managed admin policies', () => {
    for (const [id, fn] of ofType('AWS::Serverless::Function')) {
      for (const policy of [fn.Properties.Policies ?? []].flat()) {
        if (typeof policy === 'string') expect(policy, id).not.toMatch(/FullAccess|Administrator|PowerUser/);
      }
    }
  });

  it('never puts a literal secret in function environments or parameter defaults', () => {
    const SECRETISH = /secret|key|token|password/i;
    const envs = [template.Globals?.Function?.Environment?.Variables, ...ofType('AWS::Serverless::Function').map(([, r]) => r.Properties.Environment?.Variables)];
    for (const vars of envs.filter(Boolean)) {
      for (const [name, value] of Object.entries(vars)) {
        if (SECRETISH.test(name)) expect(typeof value, name).not.toBe('string');
      }
    }
    for (const [name, p] of Object.entries(template.Parameters ?? {})) {
      if (SECRETISH.test(name)) {
        expect(p.NoEcho, name).toBe(true);
        expect(p.Default, name).toBeUndefined();
      }
    }
  });
});

describe('template.yaml: runtime limits', () => {
  const globals = template.Globals?.Function ?? {};

  it.each(ofType('AWS::Serverless::Function'))('%s has a timeout, memory and a log group with retention', (_, fn) => {
    expect(fn.Properties.Timeout ?? globals.Timeout).toBeGreaterThan(0);
    expect(fn.Properties.MemorySize ?? globals.MemorySize).toBeGreaterThan(0);
    const logGroupId = fn.Properties.LoggingConfig?.LogGroup?.Ref;
    expect(template.Resources[logGroupId]?.Type).toBe('AWS::Logs::LogGroup');
    expect(template.Resources[logGroupId].Properties.RetentionInDays).toBeGreaterThan(0);
  });

  it.each(ofType('AWS::Logs::LogGroup'))('%s has a retention period', (_, group) => {
    expect(group.Properties.RetentionInDays).toBeGreaterThan(0);
  });

  it.each(ofType('AWS::Serverless::HttpApi'))('%s is throttled', (_, api) => {
    expect(api.Properties.DefaultRouteSettings.ThrottlingBurstLimit).toBeGreaterThan(0);
    expect(api.Properties.DefaultRouteSettings.ThrottlingRateLimit).toBeGreaterThan(0);
  });

  it('runs every function on the Node major from package.json engines, built for the same target', () => {
    const { engines } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const major = engines.node.match(/\d+/)[0];
    for (const [id, fn] of ofType('AWS::Serverless::Function')) {
      expect(fn.Properties.Runtime ?? globals.Runtime, id).toBe(`nodejs${major}.x`);
      expect(fn.Metadata?.BuildProperties?.Target, id).toBe(`node${major}`);
    }
  });

  it('turns live Tadabase writes on only through the AllowLiveWrites stack parameter', () => {
    expect(template.Parameters.AllowLiveWrites).toMatchObject({ Type: 'String', AllowedValues: ['true', 'false'] });
    expect(template.Parameters.AllowLiveWrites.Default).toBeUndefined(); // every stage must choose
    expect(template.Conditions.LiveWrites).toEqual({ 'Fn::Equals': [{ Ref: 'AllowLiveWrites' }, 'true'] });
    expect(globals.Environment.Variables.FIELDFLOW_ALLOW_LIVE_WRITES).toEqual({ 'Fn::If': ['LiveWrites', '1', '0'] });
  });
});

describe('samconfig.toml', () => {
  const text = readFileSync(path.join(root, 'samconfig.toml'), 'utf8');
  const sections = Object.fromEntries(
    text.split(/^\[/m).slice(1).map((chunk) => {
      const [header, ...body] = chunk.split('\n');
      return [header.replace(/\]\s*$/, ''), body.join('\n')];
    }),
  );
  const deploySections = Object.entries(sections).filter(([name]) => name.endsWith('.deploy.parameters'));

  it('has dev and prod deploy config envs', () => {
    expect(Object.keys(sections)).toEqual(expect.arrayContaining(['dev.deploy.parameters', 'prod.deploy.parameters']));
  });

  it.each(deploySections)('[%s] shows the changeset before deploying', (_, body) => {
    expect(body).toMatch(/^confirm_changeset\s*=\s*true\s*$/m);
    expect(body).not.toMatch(/confirm_changeset\s*=\s*false|no_confirm_changeset|force_upload\s*=\s*true/);
  });

  // Each stage talks to its own Tadabase app (plan 03, option A), so both allow writes.
  it.each(deploySections)('[%s] deploys the matching stage and stack, and chooses live writes', (name, body) => {
    const env = name.split('.')[0] === 'default' ? 'dev' : name.split('.')[0];
    expect(body).toContain(`parameter_overrides = "Stage=${env} AllowLiveWrites=true"`);
    expect(body).toContain(`stack_name = "fieldflow-${env}"`);
  });
});
