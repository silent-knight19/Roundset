import { createHash } from 'node:crypto';
import {
  DataClass,
  GenerationMessage,
  ProviderId,
  Purpose,
  SanitizedAiError,
  SourceDescriptor,
  SourceKind,
} from './contracts.js';

export interface AuthoritativeUserInterviewRecord {
  userId: string;
  interviewId: string;
  recordId: string;
  recordVersion: string;
  kind: SourceKind;
  ancestorRefs: ReadonlyArray<string>;
}

export interface AuthoritativeServerTemplateRecord {
  templateId: string;
  templateVersion: string;
}

export interface AuthoritativeSyntheticFixtureRecord {
  fixtureId: string;
  fixtureVersion: string;
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

export interface ResolveManifestInput {
  authenticatedUserId: string;
  interviewId: string;
  messages: ReadonlyArray<GenerationMessage>;
  descriptors: ReadonlyArray<SourceDescriptor>;
  declaredDataClasses: ReadonlyArray<DataClass>;
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

/**
 * Pure, fail-closed provenance and ownership verifier for GenerationIntent.
 * Validates all message parts, recursive DERIVED_SUMMARY lineage, owner/interview
 * boundaries, and canonical data-class derivation before any provider admission.
 */
export function resolveAndAuthorizeSourceManifest(
  input: ResolveManifestInput,
  resolver: AuthoritativeSourceResolver,
): ResolvedManifestResult {
  if (!input.authenticatedUserId || !input.interviewId) {
    throw new SanitizedAiError(
      'AI_PRIVACY_INELIGIBLE',
      'Authenticated user and interview context are required',
    );
  }

  const descriptorByRef = new Map<string, SourceDescriptor>();
  for (const descriptor of input.descriptors) {
    if (!descriptor.ref || typeof descriptor.ref !== 'string') {
      throw new SanitizedAiError('AI_PRIVACY_INELIGIBLE', 'Invalid source descriptor reference');
    }
    if (descriptorByRef.has(descriptor.ref)) {
      throw new SanitizedAiError(
        'AI_PRIVACY_INELIGIBLE',
        'Duplicate ambiguous source descriptor reference',
      );
    }
    descriptorByRef.set(descriptor.ref, descriptor);
  }

  const resolvedClassesCache = new Map<string, ReadonlySet<DataClass>>();
  const visiting = new Set<string>();

  function resolveDescriptorClasses(ref: string): ReadonlySet<DataClass> {
    const cached = resolvedClassesCache.get(ref);
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

    try {
      switch (descriptor.kind) {
        case 'TRUSTED_TEMPLATE': {
          if (descriptor.scope.type !== 'SERVER_TEMPLATE') {
            throw new SanitizedAiError(
              'AI_PRIVACY_INELIGIBLE',
              'TRUSTED_TEMPLATE requires SERVER_TEMPLATE scope',
            );
          }
          const tpl = resolver.resolveServerTemplate({
            templateId: descriptor.scope.templateId,
            templateVersion: descriptor.scope.templateVersion,
          });
          if (!tpl) {
            throw new SanitizedAiError(
              'AI_PRIVACY_INELIGIBLE',
              'Unregistered server template',
            );
          }
          derived = new Set<DataClass>();
          break;
        }

        case 'SYNTHETIC_FIXTURE': {
          if (descriptor.scope.type !== 'SYNTHETIC_FIXTURE') {
            throw new SanitizedAiError(
              'AI_PRIVACY_INELIGIBLE',
              'SYNTHETIC_FIXTURE requires SYNTHETIC_FIXTURE scope',
            );
          }
          const fixture = resolver.resolveSyntheticFixture({
            fixtureId: descriptor.scope.fixtureId,
            fixtureVersion: descriptor.scope.fixtureVersion,
          });
          if (!fixture) {
            throw new SanitizedAiError(
              'AI_PRIVACY_INELIGIBLE',
              'Unregistered synthetic fixture',
            );
          }
          derived = new Set<DataClass>(['SYNTHETIC']);
          break;
        }

        case 'CANDIDATE_RESPONSE':
        case 'CANDIDATE_CONFIGURATION':
        case 'CANDIDATE_DOCUMENT': {
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
          const record = resolver.resolveUserInterviewSource({
            userId: input.authenticatedUserId,
            interviewId: input.interviewId,
            recordId: descriptor.scope.recordId,
            recordVersion: descriptor.scope.recordVersion,
          });
          if (
            !record ||
            record.userId !== input.authenticatedUserId ||
            record.interviewId !== input.interviewId ||
            record.recordId !== descriptor.scope.recordId ||
            record.recordVersion !== descriptor.scope.recordVersion ||
            record.kind !== descriptor.kind
          ) {
            throw new SanitizedAiError(
              'AI_PRIVACY_INELIGIBLE',
              'Authoritative source resolution failed',
            );
          }
          const dataClass: DataClass =
            descriptor.kind === 'CANDIDATE_DOCUMENT' ? 'USER_DOCUMENT' : 'USER_TRANSCRIPT';
          derived = new Set<DataClass>([dataClass]);
          break;
        }

        case 'DERIVED_SUMMARY': {
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
          const record = resolver.resolveUserInterviewSource({
            userId: input.authenticatedUserId,
            interviewId: input.interviewId,
            recordId: descriptor.scope.recordId,
            recordVersion: descriptor.scope.recordVersion,
          });
          if (
            !record ||
            record.userId !== input.authenticatedUserId ||
            record.interviewId !== input.interviewId ||
            record.recordId !== descriptor.scope.recordId ||
            record.recordVersion !== descriptor.scope.recordVersion ||
            record.kind !== 'DERIVED_SUMMARY'
          ) {
            throw new SanitizedAiError(
              'AI_PRIVACY_INELIGIBLE',
              'Authoritative derived summary resolution failed',
            );
          }
          if (descriptor.ancestorRefs.length === 0) {
            throw new SanitizedAiError(
              'AI_PRIVACY_INELIGIBLE',
              'DERIVED_SUMMARY must declare at least one ancestor reference',
            );
          }

          derived = new Set<DataClass>();
          for (const ancestorRef of descriptor.ancestorRefs) {
            const ancestorClasses = resolveDescriptorClasses(ancestorRef);
            for (const cls of ancestorClasses) {
              derived.add(cls);
            }
          }
          assertValidClassCombination(derived);
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

      resolvedClassesCache.set(ref, derived);
      return derived;
    } finally {
      visiting.delete(ref);
    }
  }

  const totalClasses = new Set<DataClass>();
  const flattenedMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

  for (const message of input.messages) {
    if (!message.parts || message.parts.length === 0) {
      throw new SanitizedAiError(
        'AI_CONFIGURATION_INVALID',
        'Every generation message must contain at least one part',
      );
    }
    const textChunks: string[] = [];
    for (const part of message.parts) {
      if (!part.sourceRef) {
        throw new SanitizedAiError(
          'AI_PRIVACY_INELIGIBLE',
          'Message part is missing sourceRef',
        );
      }
      const partClasses = resolveDescriptorClasses(part.sourceRef);
      for (const cls of partClasses) {
        totalClasses.add(cls);
      }
      textChunks.push(part.text);
    }
    flattenedMessages.push({
      role: message.role,
      content: textChunks.join('\n'),
    });
  }

  assertValidClassCombination(totalClasses);

  const declaredSet = new Set<DataClass>(input.declaredDataClasses);
  if (!setsEqual(totalClasses, declaredSet)) {
    throw new SanitizedAiError(
      'AI_PRIVACY_INELIGIBLE',
      'GenerationIntent dataClasses does not match canonical provenance union',
    );
  }

  const canonicalDataClasses = sortDataClasses(totalClasses);
  const identityInput = JSON.stringify({
    u: input.authenticatedUserId,
    i: input.interviewId,
    c: canonicalDataClasses,
    n: input.descriptors.length,
  });
  const requestIdentity = createHash('sha256').update(identityInput).digest('hex').slice(0, 24);

  return {
    canonicalDataClasses,
    flattenedMessages,
    requestIdentity,
  };
}
