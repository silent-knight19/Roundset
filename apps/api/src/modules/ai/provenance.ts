import { createHmac, randomBytes } from 'node:crypto';
import {
  DataClass,
  GenerationMessage,
  ProviderId,
  Purpose,
  SanitizedAiError,
  SourceDescriptor,
  SourceKind,
} from './contracts.js';

/** Process-scoped ephemeral key for privacy-safe internal request/permit binding. */
const EPHEMERAL_PERMIT_HMAC_KEY = randomBytes(32);

export interface AuthoritativeAncestorIdentity {
  kind: SourceKind;
  recordId: string;
  recordVersion: string;
}

export interface AuthoritativeUserInterviewRecord {
  userId: string;
  interviewId: string;
  recordId: string;
  recordVersion: string;
  kind: SourceKind;
  ancestorRefs: ReadonlyArray<string>;
  authoritativeAncestors?: ReadonlyArray<AuthoritativeAncestorIdentity>;
  content: string;
}

export interface AuthoritativeServerTemplateRecord {
  templateId: string;
  templateVersion: string;
  content: string;
}

export interface AuthoritativeSyntheticFixtureRecord {
  fixtureId: string;
  fixtureVersion: string;
  content: string;
}

export interface AuthoritativeSourceResolver {
  resolveUserInterviewSource(query: {
    userId: string;
    interviewId: string;
    recordId: string;
    recordVersion: string;
  }): AuthoritativeUserInterviewRecord | null;

  resolveServerTemplate(query: {
    templateId: string;
    templateVersion: string;
  }): AuthoritativeServerTemplateRecord | null;

  resolveSyntheticFixture(query: {
    fixtureId: string;
    fixtureVersion: string;
  }): AuthoritativeSyntheticFixtureRecord | null;
}

export interface ProviderEligibilityPolicy {
  isEligible(input: {
    provider: ProviderId;
    purpose: Purpose;
    dataClasses: ReadonlyArray<DataClass>;
    isFallbackOrRepair: boolean;
  }): boolean;
}

export interface RequestBindingMetadata {
  operationId: string;
  generationEpoch: number;
  attemptId: string;
  attemptNo: number;
  provider: ProviderId;
  purpose: Purpose;
  promptVersion: string;
  outputSchemaVersion: string;
  maxOutputTokens: number;
  estimatedInputTokens: number;
  reasoningProfile: 'NO_REASONING' | 'LOW';
  absoluteDeadlineAt: string;
}

export interface ResolveManifestInput {
  authenticatedUserId: string;
  interviewId: string;
  messages: ReadonlyArray<GenerationMessage>;
  descriptors: ReadonlyArray<SourceDescriptor>;
  declaredDataClasses: ReadonlyArray<DataClass>;
  requestBinding?: RequestBindingMetadata;
}

export interface ResolvedManifestResult {
  canonicalDataClasses: ReadonlyArray<DataClass>;
  flattenedMessages: ReadonlyArray<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  requestIdentity: string;
}

/**
 * Deterministic in-memory fake resolver for offline unit/contract tests.
 * Never connects to MongoDB or any external service.
 */
export class DeterministicFakeSourceResolver implements AuthoritativeSourceResolver {
  private readonly userSources = new Map<string, AuthoritativeUserInterviewRecord>();
  private readonly serverTemplates = new Map<string, AuthoritativeServerTemplateRecord>();
  private readonly syntheticFixtures = new Map<string, AuthoritativeSyntheticFixtureRecord>();

  public registerUserInterviewSource(record: AuthoritativeUserInterviewRecord): void {
    const key = `${record.userId}:${record.interviewId}:${record.recordId}:${record.recordVersion}`;
    this.userSources.set(key, record);
  }

  public registerServerTemplate(record: AuthoritativeServerTemplateRecord): void {
    const key = `${record.templateId}:${record.templateVersion}`;
    this.serverTemplates.set(key, record);
  }

  public registerSyntheticFixture(record: AuthoritativeSyntheticFixtureRecord): void {
    const key = `${record.fixtureId}:${record.fixtureVersion}`;
    this.syntheticFixtures.set(key, record);
  }

  public resolveUserInterviewSource(query: {
    userId: string;
    interviewId: string;
    recordId: string;
    recordVersion: string;
  }): AuthoritativeUserInterviewRecord | null {
    const key = `${query.userId}:${query.interviewId}:${query.recordId}:${query.recordVersion}`;
    return this.userSources.get(key) ?? null;
  }

  public resolveServerTemplate(query: {
    templateId: string;
    templateVersion: string;
  }): AuthoritativeServerTemplateRecord | null {
    const key = `${query.templateId}:${query.templateVersion}`;
    return this.serverTemplates.get(key) ?? null;
  }

  public resolveSyntheticFixture(query: {
    fixtureId: string;
    fixtureVersion: string;
  }): AuthoritativeSyntheticFixtureRecord | null {
    const key = `${query.fixtureId}:${query.fixtureVersion}`;
    return this.syntheticFixtures.get(key) ?? null;
  }
}

function setsEqual<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

function sortDataClasses(classes: ReadonlySet<DataClass>): ReadonlyArray<DataClass> {
  const order: Record<DataClass, number> = {
    SYNTHETIC: 0,
    USER_TRANSCRIPT: 1,
    USER_DOCUMENT: 2,
  };
  return Array.from(classes).sort((a, b) => order[a] - order[b]);
}

function assertValidClassCombination(classes: ReadonlySet<DataClass>): void {
  if (classes.has('SYNTHETIC') && (classes.has('USER_TRANSCRIPT') || classes.has('USER_DOCUMENT'))) {
    throw new SanitizedAiError(
      'AI_PRIVACY_INELIGIBLE',
      'SYNTHETIC data class cannot coexist with real user data classes',
    );
  }
}

function safeInvokeResolver<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof SanitizedAiError) {
      throw err;
    }
    // Map unexpected resolver errors to a sanitized error without leaking source details.
    throw new SanitizedAiError(
      'AI_PROVIDER_UNAVAILABLE',
      'Authoritative source resolution failed unexpectedly',
    );
  }
}

function assertNoDuplicateRefs(refs: ReadonlyArray<string>, label: string): void {
  if (!Array.isArray(refs)) {
    throw new SanitizedAiError('AI_CONFIGURATION_INVALID', `Invalid ${label} list`);
  }
  const seen = new Set<string>();
  for (const ref of refs) {
    if (typeof ref !== 'string' || ref.length === 0) {
      throw new SanitizedAiError('AI_PRIVACY_INELIGIBLE', `Invalid reference in ${label}`);
    }
    if (seen.has(ref)) {
      throw new SanitizedAiError('AI_PRIVACY_INELIGIBLE', `Duplicate reference in ${label}`);
    }
    seen.add(ref);
  }
}

interface ResolvedDescriptorInfo {
  classes: ReadonlySet<DataClass>;
  authoritativeContent: string;
  authoritativeIdentity: string;
}

/**
 * Pure, fail-closed provenance and ownership verifier for GenerationIntent.
 * Validates all message parts against authoritative source content, recursive
 * DERIVED_SUMMARY lineage, owner/interview boundaries, and canonical data-class derivation.
 */
export function resolveAndAuthorizeSourceManifest(
  input: ResolveManifestInput,
  resolver: AuthoritativeSourceResolver,
): ResolvedManifestResult {
  if (!input || typeof input !== 'object') {
    throw new SanitizedAiError('AI_CONFIGURATION_INVALID', 'Manifest input must be an object');
  }
  if (
    typeof input.authenticatedUserId !== 'string' ||
    input.authenticatedUserId.length === 0 ||
    typeof input.interviewId !== 'string' ||
    input.interviewId.length === 0
  ) {
    throw new SanitizedAiError(
      'AI_PRIVACY_INELIGIBLE',
      'Authenticated user and interview context are required',
    );
  }
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw new SanitizedAiError(
      'AI_CONFIGURATION_INVALID',
      'Generation messages must be a non-empty array',
    );
  }
  if (!Array.isArray(input.descriptors)) {
    throw new SanitizedAiError(
      'AI_CONFIGURATION_INVALID',
      'Source descriptors must be an array',
    );
  }
  if (!Array.isArray(input.declaredDataClasses)) {
    throw new SanitizedAiError(
      'AI_CONFIGURATION_INVALID',
      'Declared dataClasses must be an array',
    );
  }
  if (!resolver || typeof resolver !== 'object') {
    throw new SanitizedAiError('AI_CONFIGURATION_INVALID', 'Authoritative resolver is required');
  }

  const descriptorByRef = new Map<string, SourceDescriptor>();
  for (const descriptor of input.descriptors) {
    if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.ref !== 'string' || descriptor.ref.length === 0) {
      throw new SanitizedAiError('AI_PRIVACY_INELIGIBLE', 'Invalid source descriptor reference');
    }
    if (!Array.isArray(descriptor.inheritedClasses) || !Array.isArray(descriptor.ancestorRefs)) {
      throw new SanitizedAiError('AI_CONFIGURATION_INVALID', 'Malformed source descriptor arrays');
    }
    if (!descriptor.scope || typeof descriptor.scope !== 'object') {
      throw new SanitizedAiError('AI_PRIVACY_INELIGIBLE', 'Missing source descriptor scope');
    }
    if (descriptorByRef.has(descriptor.ref)) {
      throw new SanitizedAiError(
        'AI_PRIVACY_INELIGIBLE',
        'Duplicate ambiguous source descriptor reference',
      );
    }
    descriptorByRef.set(descriptor.ref, descriptor);
  }

  const resolvedCache = new Map<string, ResolvedDescriptorInfo>();
  const visiting = new Set<string>();

  function resolveDescriptor(ref: string): ResolvedDescriptorInfo {
    const cached = resolvedCache.get(ref);
    if (cached) return cached;

    if (visiting.has(ref)) {
      throw new SanitizedAiError(
        'AI_PRIVACY_INELIGIBLE',
        'Cyclic source lineage detected',
      );
    }

    const descriptor = descriptorByRef.get(ref);
    if (!descriptor) {
      throw new SanitizedAiError(
        'AI_PRIVACY_INELIGIBLE',
        'Missing or dangling source descriptor reference',
      );
    }

    visiting.add(ref);
    let derived: Set<DataClass>;
    let authoritativeContent: string;
    let authoritativeIdentity: string;

    try {
      switch (descriptor.kind) {
        case 'TRUSTED_TEMPLATE': {
          assertNoDuplicateRefs(descriptor.ancestorRefs, 'TRUSTED_TEMPLATE ancestorRefs');
          if (descriptor.ancestorRefs.length > 0) {
            throw new SanitizedAiError(
              'AI_PRIVACY_INELIGIBLE',
              'Root template source must not declare ancestorRefs',
            );
          }
          if (descriptor.scope.type !== 'SERVER_TEMPLATE') {
            throw new SanitizedAiError(
              'AI_PRIVACY_INELIGIBLE',
              'TRUSTED_TEMPLATE requires SERVER_TEMPLATE scope',
            );
          }
          const { templateId, templateVersion } = descriptor.scope;
          const tpl = safeInvokeResolver(() =>
            resolver.resolveServerTemplate({ templateId, templateVersion }),
          );
          if (
            !tpl ||
            tpl.templateId !== templateId ||
            tpl.templateVersion !== templateVersion ||
            typeof tpl.content !== 'string'
          ) {
            throw new SanitizedAiError(
              'AI_PRIVACY_INELIGIBLE',
              'Unregistered or mismatched server template',
            );
          }
          derived = new Set<DataClass>();
          authoritativeContent = tpl.content;
          authoritativeIdentity = `tpl:${tpl.templateId}:${tpl.templateVersion}`;
          break;
        }

        case 'SYNTHETIC_FIXTURE': {
          assertNoDuplicateRefs(descriptor.ancestorRefs, 'SYNTHETIC_FIXTURE ancestorRefs');
          if (descriptor.ancestorRefs.length > 0) {
            throw new SanitizedAiError(
              'AI_PRIVACY_INELIGIBLE',
              'Root synthetic fixture must not declare ancestorRefs',
            );
          }
          if (descriptor.scope.type !== 'SYNTHETIC_FIXTURE') {
            throw new SanitizedAiError(
              'AI_PRIVACY_INELIGIBLE',
              'SYNTHETIC_FIXTURE requires SYNTHETIC_FIXTURE scope',
            );
          }
          const { fixtureId, fixtureVersion } = descriptor.scope;
          const fixture = safeInvokeResolver(() =>
            resolver.resolveSyntheticFixture({ fixtureId, fixtureVersion }),
          );
          if (
            !fixture ||
            fixture.fixtureId !== fixtureId ||
            fixture.fixtureVersion !== fixtureVersion ||
            typeof fixture.content !== 'string'
          ) {
            throw new SanitizedAiError(
              'AI_PRIVACY_INELIGIBLE',
              'Unregistered or mismatched synthetic fixture',
            );
          }
          derived = new Set<DataClass>(['SYNTHETIC']);
          authoritativeContent = fixture.content;
          authoritativeIdentity = `fix:${fixture.fixtureId}:${fixture.fixtureVersion}`;
          break;
        }

        case 'CANDIDATE_RESPONSE':
        case 'CANDIDATE_CONFIGURATION':
        case 'CANDIDATE_DOCUMENT': {
          assertNoDuplicateRefs(descriptor.ancestorRefs, 'root source ancestorRefs');
          if (descriptor.ancestorRefs.length > 0) {
            throw new SanitizedAiError(
              'AI_PRIVACY_INELIGIBLE',
              'Root candidate source must not declare ancestorRefs',
            );
          }
          if (descriptor.scope.type !== 'USER_INTERVIEW') {
            throw new SanitizedAiError(
              'AI_PRIVACY_INELIGIBLE',
              'Candidate source requires USER_INTERVIEW scope',
            );
          }
          if (
            descriptor.scope.userId !== input.authenticatedUserId ||
            descriptor.scope.interviewId !== input.interviewId
          ) {
            throw new SanitizedAiError(
              'AI_PRIVACY_INELIGIBLE',
              'Source scope does not match authenticated principal or current interview',
            );
          }
          const { recordId, recordVersion } = descriptor.scope;
          const record = safeInvokeResolver(() =>
            resolver.resolveUserInterviewSource({
              userId: input.authenticatedUserId,
              interviewId: input.interviewId,
              recordId,
              recordVersion,
            }),
          );
          if (
            !record ||
            record.userId !== input.authenticatedUserId ||
            record.interviewId !== input.interviewId ||
            record.recordId !== recordId ||
            record.recordVersion !== recordVersion ||
            record.kind !== descriptor.kind ||
            typeof record.content !== 'string'
          ) {
            throw new SanitizedAiError(
              'AI_PRIVACY_INELIGIBLE',
              'Authoritative source resolution failed',
            );
          }
          if (!Array.isArray(record.ancestorRefs) || record.ancestorRefs.length > 0) {
            throw new SanitizedAiError(
              'AI_PRIVACY_INELIGIBLE',
              'Root source must not conceal undeclared derived lineage',
            );
          }
          const dataClass: DataClass =
            descriptor.kind === 'CANDIDATE_DOCUMENT' ? 'USER_DOCUMENT' : 'USER_TRANSCRIPT';
          derived = new Set<DataClass>([dataClass]);
          authoritativeContent = record.content;
          authoritativeIdentity = `usr:${record.userId}:${record.interviewId}:${record.recordId}:${record.recordVersion}`;
          break;
        }

        case 'DERIVED_SUMMARY': {
          assertNoDuplicateRefs(descriptor.ancestorRefs, 'DERIVED_SUMMARY ancestorRefs');
          if (descriptor.scope.type !== 'USER_INTERVIEW') {
            throw new SanitizedAiError(
              'AI_PRIVACY_INELIGIBLE',
              'DERIVED_SUMMARY requires USER_INTERVIEW scope',
            );
          }
          if (
            descriptor.scope.userId !== input.authenticatedUserId ||
            descriptor.scope.interviewId !== input.interviewId
          ) {
            throw new SanitizedAiError(
              'AI_PRIVACY_INELIGIBLE',
              'Derived summary scope does not match authenticated principal or current interview',
            );
          }
          const { recordId, recordVersion } = descriptor.scope;
          const record = safeInvokeResolver(() =>
            resolver.resolveUserInterviewSource({
              userId: input.authenticatedUserId,
              interviewId: input.interviewId,
              recordId,
              recordVersion,
            }),
          );
          if (
            !record ||
            record.userId !== input.authenticatedUserId ||
            record.interviewId !== input.interviewId ||
            record.recordId !== recordId ||
            record.recordVersion !== recordVersion ||
            record.kind !== 'DERIVED_SUMMARY' ||
            typeof record.content !== 'string'
          ) {
            throw new SanitizedAiError(
              'AI_PRIVACY_INELIGIBLE',
              'Authoritative derived summary resolution failed',
            );
          }
          assertNoDuplicateRefs(record.ancestorRefs, 'authoritative ancestorRefs');
          if (record.ancestorRefs.length === 0 || descriptor.ancestorRefs.length === 0) {
            throw new SanitizedAiError(
              'AI_PRIVACY_INELIGIBLE',
              'DERIVED_SUMMARY must declare at least one ancestor reference',
            );
          }
          if (
            !Array.isArray(record.authoritativeAncestors) ||
            record.authoritativeAncestors.length === 0
          ) {
            throw new SanitizedAiError(
              'AI_PRIVACY_INELIGIBLE',
              'DERIVED_SUMMARY requires non-empty authoritativeAncestors',
            );
          }

          const expectedKeys = new Set<string>();
          for (const anc of record.authoritativeAncestors) {
            if (
              !anc ||
              typeof anc !== 'object' ||
              typeof anc.kind !== 'string' ||
              anc.kind.length === 0 ||
              typeof anc.recordId !== 'string' ||
              anc.recordId.length === 0 ||
              typeof anc.recordVersion !== 'string' ||
              anc.recordVersion.length === 0
            ) {
              throw new SanitizedAiError(
                'AI_PRIVACY_INELIGIBLE',
                'Malformed authoritativeAncestors entry',
              );
            }
            expectedKeys.add(`${anc.kind}:${anc.recordId}:${anc.recordVersion}`);
          }

          const declaredAncestors = new Set<string>(descriptor.ancestorRefs);
          const authoritativeAncestors = new Set<string>(record.ancestorRefs);
          if (!setsEqual(declaredAncestors, authoritativeAncestors)) {
            throw new SanitizedAiError(
              'AI_PRIVACY_INELIGIBLE',
              'Declared DERIVED_SUMMARY ancestorRefs do not match authoritative lineage',
            );
          }

          derived = new Set<DataClass>();
          const ancestorIdentities: string[] = [];
          const resolvedAncestorKeys = new Set<string>();
          for (const ancestorRef of record.ancestorRefs) {
            const ancestorInfo = resolveDescriptor(ancestorRef);
            for (const cls of ancestorInfo.classes) {
              derived.add(cls);
            }
            ancestorIdentities.push(ancestorInfo.authoritativeIdentity);
            const ancestorDesc = descriptorByRef.get(ancestorRef);
            if (!ancestorDesc || ancestorDesc.scope.type !== 'USER_INTERVIEW') {
              throw new SanitizedAiError(
                'AI_PRIVACY_INELIGIBLE',
                'DERIVED_SUMMARY ancestors must be authoritative USER_INTERVIEW sources',
              );
            }
            resolvedAncestorKeys.add(
              `${ancestorDesc.kind}:${ancestorDesc.scope.recordId}:${ancestorDesc.scope.recordVersion}`,
            );
          }
          if (!setsEqual(resolvedAncestorKeys, expectedKeys)) {
            throw new SanitizedAiError(
              'AI_PRIVACY_INELIGIBLE',
              'Resolved ancestor identities do not match authoritative summary lineage',
            );
          }
          assertValidClassCombination(derived);
          authoritativeContent = record.content;
          authoritativeIdentity = `sum:${record.userId}:${record.interviewId}:${record.recordId}:${record.recordVersion}[${ancestorIdentities.sort().join(',')}]`;
          break;
        }

        default: {
          throw new SanitizedAiError('AI_PRIVACY_INELIGIBLE', 'Unknown source kind');
        }
      }

      const declaredInherited = new Set<DataClass>(descriptor.inheritedClasses);
      if (!setsEqual(derived, declaredInherited)) {
        throw new SanitizedAiError(
          'AI_PRIVACY_INELIGIBLE',
          'Descriptor inheritedClasses does not match canonical provenance',
        );
      }

      const info: ResolvedDescriptorInfo = {
        classes: derived,
        authoritativeContent,
        authoritativeIdentity,
      };
      resolvedCache.set(ref, info);
      return info;
    } finally {
      visiting.delete(ref);
    }
  }

  const totalClasses = new Set<DataClass>();
  const flattenedMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  const messageComposition: Array<{
    role: string;
    parts: Array<{ sourceIdentity: string; contentMac: string }>;
  }> = [];

  for (const message of input.messages) {
    if (
      !message ||
      typeof message !== 'object' ||
      (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant') ||
      !Array.isArray(message.parts) ||
      message.parts.length === 0
    ) {
      throw new SanitizedAiError(
        'AI_CONFIGURATION_INVALID',
        'Every generation message must have a valid role and at least one part',
      );
    }
    const textChunks: string[] = [];
    const partBindings: Array<{ sourceIdentity: string; contentMac: string }> = [];

    for (const part of message.parts) {
      if (
        !part ||
        typeof part !== 'object' ||
        typeof part.sourceRef !== 'string' ||
        part.sourceRef.length === 0 ||
        typeof part.text !== 'string'
      ) {
        throw new SanitizedAiError(
          'AI_PRIVACY_INELIGIBLE',
          'Message part is missing valid sourceRef or text',
        );
      }

      const resolvedInfo = resolveDescriptor(part.sourceRef);
      if (part.text !== resolvedInfo.authoritativeContent) {
        throw new SanitizedAiError(
          'AI_PRIVACY_INELIGIBLE',
          'Message part content does not match authoritative source record',
        );
      }

      for (const cls of resolvedInfo.classes) {
        totalClasses.add(cls);
      }
      textChunks.push(resolvedInfo.authoritativeContent);

      const contentMac = createHmac('sha256', EPHEMERAL_PERMIT_HMAC_KEY)
        .update(resolvedInfo.authoritativeContent)
        .digest('hex');
      partBindings.push({
        sourceIdentity: resolvedInfo.authoritativeIdentity,
        contentMac,
      });
    }

    flattenedMessages.push({
      role: message.role,
      content: textChunks.join('\n'),
    });
    messageComposition.push({
      role: message.role,
      parts: partBindings,
    });
  }

  assertValidClassCombination(totalClasses);

  if (totalClasses.size === 0) {
    throw new SanitizedAiError(
      'AI_PRIVACY_INELIGIBLE',
      'Final canonical data-class union must not be empty',
    );
  }

  const declaredSet = new Set<DataClass>(input.declaredDataClasses);
  if (!setsEqual(totalClasses, declaredSet)) {
    throw new SanitizedAiError(
      'AI_PRIVACY_INELIGIBLE',
      'GenerationIntent dataClasses does not match canonical provenance union',
    );
  }

  const canonicalDataClasses = sortDataClasses(totalClasses);
  const bindingPayload = JSON.stringify({
    authenticatedUserId: input.authenticatedUserId,
    interviewId: input.interviewId,
    canonicalDataClasses,
    requestBinding: input.requestBinding ?? null,
    messageComposition,
  });
  const requestIdentity = createHmac('sha256', EPHEMERAL_PERMIT_HMAC_KEY)
    .update(bindingPayload)
    .digest('hex')
    .slice(0, 32);

  return {
    canonicalDataClasses,
    flattenedMessages,
    requestIdentity,
  };
}
