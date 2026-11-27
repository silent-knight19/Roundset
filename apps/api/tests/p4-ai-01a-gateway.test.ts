import { describe, expect, it, vi } from 'vitest';
import {
  AuthoritativeSourceResolver,
  computeEffectiveProviderTimeoutMs,
  computePostStartCutoff,
  computePreStartCutoff,
  CutoffMode,
  DeterministicFakeSourceResolver,
  executeOfflineGeneration,
  GenerationIntent,
  PostStartDeadlineInput,
  ProviderEligibilityPolicy,
  resolveAndAuthorizeSourceManifest,
  SanitizedAiError,
} from '../src/modules/ai/index.js';

const NOW_MS = Date.parse('2026-11-27T12:00:00.000Z');

function makePreStartDeadlines(offsetMs = 60_000) {
  return {
    readyExpiresAt: NOW_MS + offsetMs,
    reservationExpiresAt: NOW_MS + offsetMs,
    controllerLeaseUntil: NOW_MS + offsetMs,
    requestDeadline: NOW_MS + offsetMs,
  };
}

function makePostStartDeadlines(offsetMs = 60_000): PostStartDeadlineInput {
  return {
    controllerLeaseUntil: NOW_MS + offsetMs,
    effectiveDeadlineAt: NOW_MS + offsetMs,
    requestDeadline: NOW_MS + offsetMs,
    hardExpiryAt: NOW_MS + offsetMs * 2,
  };
}

function createBaseIntent(overrides: Partial<GenerationIntent> = {}): GenerationIntent {
  return {
    operationId: 'op-001',
    generationEpoch: 1,
    attemptId: 'att-001',
    attemptNo: 1,
    interviewId: 'int-a-1',
    purpose: 'QUESTION',
    outputSchemaVersion: '1.0.0',
    promptVersion: '1.0.0',
    dataClasses: ['USER_TRANSCRIPT'],
    sourceManifest: [
      {
        ref: 'resp-a-1',
        kind: 'CANDIDATE_RESPONSE',
        inheritedClasses: ['USER_TRANSCRIPT'],
        ancestorRefs: [],
        scope: {
          type: 'USER_INTERVIEW',
          userId: 'user-a',
          interviewId: 'int-a-1',
          recordId: 'rec-resp-1',
          recordVersion: 'v1',
        },
      },
    ],
    messages: [
      {
        role: 'user',
        parts: [{ text: 'Synthetic candidate answer', sourceRef: 'resp-a-1' }],
      },
    ],
    maxOutputTokens: 256,
    estimatedInputTokens: 32,
    absoluteDeadlineAt: new Date(NOW_MS + 60_000).toISOString(),
    reasoningProfile: 'NO_REASONING',
    ...overrides,
  };
}

describe('P4-AI-01a: Offline AI Gateway Foundation', () => {
  it('1. A-owned response and same-interview summary with correctly inherited classes succeeds under approving policy', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-resp-1',
      recordVersion: 'v1',
      kind: 'CANDIDATE_RESPONSE',
      ancestorRefs: [],
      content: 'Synthetic candidate answer',
    });
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-sum-1',
      recordVersion: 'v1',
      kind: 'DERIVED_SUMMARY',
      ancestorRefs: ['resp-a-1'],
      authoritativeAncestors: [
        { kind: 'CANDIDATE_RESPONSE', recordId: 'rec-resp-1', recordVersion: 'v1' },
      ],
      content: 'Synthetic summary context',
    });

    const policy: ProviderEligibilityPolicy = { isEligible: () => true };

    const intent = createBaseIntent({
      dataClasses: ['USER_TRANSCRIPT'],
      sourceManifest: [
        {
          ref: 'resp-a-1',
          kind: 'CANDIDATE_RESPONSE',
          inheritedClasses: ['USER_TRANSCRIPT'],
          ancestorRefs: [],
          scope: {
            type: 'USER_INTERVIEW',
            userId: 'user-a',
            interviewId: 'int-a-1',
            recordId: 'rec-resp-1',
            recordVersion: 'v1',
          },
        },
        {
          ref: 'sum-a-1',
          kind: 'DERIVED_SUMMARY',
          inheritedClasses: ['USER_TRANSCRIPT'],
          ancestorRefs: ['resp-a-1'],
          scope: {
            type: 'USER_INTERVIEW',
            userId: 'user-a',
            interviewId: 'int-a-1',
            recordId: 'rec-sum-1',
            recordVersion: 'v1',
          },
        },
      ],
      messages: [
        {
          role: 'user',
          parts: [{ text: 'Synthetic summary context', sourceRef: 'sum-a-1' }],
        },
      ],
    });

    const result = executeOfflineGeneration(
      {
        authenticatedUserId: 'user-a',
        intent,
        provider: 'MOCK',
        cutoffMode: 'POST_START',
        deadlineInput: makePostStartDeadlines(),
        nowMs: NOW_MS,
      },
      { resolver, eligibilityPolicy: policy },
    );

    expect(result.provider).toBe('MOCK');
    expect(result.attemptId).toBe('att-001');
    expect(result.usage.estimated).toBe(true);
  });

  it('2. Rejects before mock dispatch when A references B transcript/summary under colliding slot ID', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerUserInterviewSource({
      userId: 'user-b',
      interviewId: 'int-a-1',
      recordId: 'slot-1',
      recordVersion: 'v1',
      kind: 'CANDIDATE_RESPONSE',
      ancestorRefs: [],
      content: 'Colliding slot',
    });

    const isEligibleSpy = vi.fn(() => true);
    const policy: ProviderEligibilityPolicy = { isEligible: isEligibleSpy };

    const intent = createBaseIntent({
      sourceManifest: [
        {
          ref: 'slot-1',
          kind: 'CANDIDATE_RESPONSE',
          inheritedClasses: ['USER_TRANSCRIPT'],
          ancestorRefs: [],
          scope: {
            type: 'USER_INTERVIEW',
            userId: 'user-b',
            interviewId: 'int-a-1',
            recordId: 'slot-1',
            recordVersion: 'v1',
          },
        },
      ],
      messages: [{ role: 'user', parts: [{ text: 'Colliding slot', sourceRef: 'slot-1' }] }],
    });

    expect(() =>
      executeOfflineGeneration(
        {
          authenticatedUserId: 'user-a',
          intent,
          provider: 'MOCK',
          cutoffMode: 'PRE_START',
          deadlineInput: makePreStartDeadlines(),
          nowMs: NOW_MS,
        },
        { resolver, eligibilityPolicy: policy },
      ),
    ).toThrowError(SanitizedAiError);

    expect(isEligibleSpy).not.toHaveBeenCalled();
  });

  it('3. Same-user other-interview source and spoofed user-scope metadata reject against resolver records', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-other',
      recordId: 'rec-other',
      recordVersion: 'v1',
      kind: 'CANDIDATE_RESPONSE',
      ancestorRefs: [],
      content: 'Other interview',
    });

    const otherInterviewIntent = createBaseIntent({
      interviewId: 'int-a-1',
      sourceManifest: [
        {
          ref: 'other-int',
          kind: 'CANDIDATE_RESPONSE',
          inheritedClasses: ['USER_TRANSCRIPT'],
          ancestorRefs: [],
          scope: {
            type: 'USER_INTERVIEW',
            userId: 'user-a',
            interviewId: 'int-a-other',
            recordId: 'rec-other',
            recordVersion: 'v1',
          },
        },
      ],
      messages: [{ role: 'user', parts: [{ text: 'Other interview', sourceRef: 'other-int' }] }],
    });

    expect(() =>
      resolveAndAuthorizeSourceManifest(
        {
          authenticatedUserId: 'user-a',
          interviewId: otherInterviewIntent.interviewId,
          messages: otherInterviewIntent.messages,
          descriptors: otherInterviewIntent.sourceManifest,
          declaredDataClasses: otherInterviewIntent.dataClasses,
        },
        resolver,
      ),
    ).toThrowError(SanitizedAiError);

    const spoofedIntent = createBaseIntent({
      interviewId: 'int-a-1',
      sourceManifest: [
        {
          ref: 'spoofed',
          kind: 'CANDIDATE_RESPONSE',
          inheritedClasses: ['USER_TRANSCRIPT'],
          ancestorRefs: [],
          scope: {
            type: 'USER_INTERVIEW',
            userId: 'user-a',
            interviewId: 'int-a-1',
            recordId: 'rec-other',
            recordVersion: 'v1',
          },
        },
      ],
      messages: [{ role: 'user', parts: [{ text: 'Other interview', sourceRef: 'spoofed' }] }],
    });

    expect(() =>
      resolveAndAuthorizeSourceManifest(
        {
          authenticatedUserId: 'user-a',
          interviewId: spoofedIntent.interviewId,
          messages: spoofedIntent.messages,
          descriptors: spoofedIntent.sourceManifest,
          declaredDataClasses: spoofedIntent.dataClasses,
        },
        resolver,
      ),
    ).toThrowError(SanitizedAiError);
  });

  it('4. Derived summary referencing foreign/wrong-scope ancestor, cyclic ancestry, or missing ancestry rejects', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-sum-1',
      recordVersion: 'v1',
      kind: 'DERIVED_SUMMARY',
      ancestorRefs: ['missing-ref'],
      content: 'Sum',
    });

    expect(() =>
      resolveAndAuthorizeSourceManifest(
        {
          authenticatedUserId: 'user-a',
          interviewId: 'int-a-1',
          messages: [{ role: 'user', parts: [{ text: 'Sum', sourceRef: 'sum-1' }] }],
          descriptors: [
            {
              ref: 'sum-1',
              kind: 'DERIVED_SUMMARY',
              inheritedClasses: ['USER_TRANSCRIPT'],
              ancestorRefs: ['missing-ref'],
              scope: {
                type: 'USER_INTERVIEW',
                userId: 'user-a',
                interviewId: 'int-a-1',
                recordId: 'rec-sum-1',
                recordVersion: 'v1',
              },
            },
          ],
          declaredDataClasses: ['USER_TRANSCRIPT'],
        },
        resolver,
      ),
    ).toThrowError(SanitizedAiError);

    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-sum-1',
      recordVersion: 'v1',
      kind: 'DERIVED_SUMMARY',
      ancestorRefs: ['sum-2'],
      content: 'Cycle',
    });
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-sum-2',
      recordVersion: 'v1',
      kind: 'DERIVED_SUMMARY',
      ancestorRefs: ['sum-1'],
      content: 'Cycle 2',
    });

    expect(() =>
      resolveAndAuthorizeSourceManifest(
        {
          authenticatedUserId: 'user-a',
          interviewId: 'int-a-1',
          messages: [{ role: 'user', parts: [{ text: 'Cycle', sourceRef: 'sum-1' }] }],
          descriptors: [
            {
              ref: 'sum-1',
              kind: 'DERIVED_SUMMARY',
              inheritedClasses: ['USER_TRANSCRIPT'],
              ancestorRefs: ['sum-2'],
              scope: {
                type: 'USER_INTERVIEW',
                userId: 'user-a',
                interviewId: 'int-a-1',
                recordId: 'rec-sum-1',
                recordVersion: 'v1',
              },
            },
            {
              ref: 'sum-2',
              kind: 'DERIVED_SUMMARY',
              inheritedClasses: ['USER_TRANSCRIPT'],
              ancestorRefs: ['sum-1'],
              scope: {
                type: 'USER_INTERVIEW',
                userId: 'user-a',
                interviewId: 'int-a-1',
                recordId: 'rec-sum-2',
                recordVersion: 'v1',
              },
            },
          ],
          declaredDataClasses: ['USER_TRANSCRIPT'],
        },
        resolver,
      ),
    ).toThrowError(SanitizedAiError);
  });

  it('5. Mixed USER_TRANSCRIPT + USER_DOCUMENT requires all-of both permissions; synthetic+real denies', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-resp-1',
      recordVersion: 'v1',
      kind: 'CANDIDATE_RESPONSE',
      ancestorRefs: [],
      content: 'Answer',
    });
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-doc-1',
      recordVersion: 'v1',
      kind: 'CANDIDATE_DOCUMENT',
      ancestorRefs: [],
      content: 'Resume',
    });
    resolver.registerSyntheticFixture({
      fixtureId: 'fix-1',
      fixtureVersion: 'v1',
      content: 'Fixture',
    });

    const mixedIntent = createBaseIntent({
      dataClasses: ['USER_TRANSCRIPT', 'USER_DOCUMENT'],
      sourceManifest: [
        {
          ref: 'resp-1',
          kind: 'CANDIDATE_RESPONSE',
          inheritedClasses: ['USER_TRANSCRIPT'],
          ancestorRefs: [],
          scope: {
            type: 'USER_INTERVIEW',
            userId: 'user-a',
            interviewId: 'int-a-1',
            recordId: 'rec-resp-1',
            recordVersion: 'v1',
          },
        },
        {
          ref: 'doc-1',
          kind: 'CANDIDATE_DOCUMENT',
          inheritedClasses: ['USER_DOCUMENT'],
          ancestorRefs: [],
          scope: {
            type: 'USER_INTERVIEW',
            userId: 'user-a',
            interviewId: 'int-a-1',
            recordId: 'rec-doc-1',
            recordVersion: 'v1',
          },
        },
      ],
      messages: [
        {
          role: 'user',
          parts: [
            { text: 'Answer', sourceRef: 'resp-1' },
            { text: 'Resume', sourceRef: 'doc-1' },
          ],
        },
      ],
    });

    const onlyTranscriptPolicy: ProviderEligibilityPolicy = {
      isEligible: ({ dataClasses }) =>
        dataClasses.includes('USER_TRANSCRIPT') && !dataClasses.includes('USER_DOCUMENT'),
    };
    expect(() =>
      executeOfflineGeneration(
        {
          authenticatedUserId: 'user-a',
          intent: mixedIntent,
          provider: 'MOCK',
          cutoffMode: 'PRE_START',
          deadlineInput: makePreStartDeadlines(),
          nowMs: NOW_MS,
        },
        { resolver, eligibilityPolicy: onlyTranscriptPolicy },
      ),
    ).toThrowError(SanitizedAiError);

    const synthPlusRealIntent = createBaseIntent({
      dataClasses: ['SYNTHETIC', 'USER_TRANSCRIPT'],
      sourceManifest: [
        mixedIntent.sourceManifest[0],
        {
          ref: 'fix-1',
          kind: 'SYNTHETIC_FIXTURE',
          inheritedClasses: ['SYNTHETIC'],
          ancestorRefs: [],
          scope: { type: 'SYNTHETIC_FIXTURE', fixtureId: 'fix-1', fixtureVersion: 'v1' },
        },
      ],
      messages: [
        {
          role: 'user',
          parts: [
            { text: 'Answer', sourceRef: 'resp-1' },
            { text: 'Fixture', sourceRef: 'fix-1' },
          ],
        },
      ],
    });

    expect(() =>
      resolveAndAuthorizeSourceManifest(
        {
          authenticatedUserId: 'user-a',
          interviewId: 'int-a-1',
          messages: synthPlusRealIntent.messages,
          descriptors: synthPlusRealIntent.sourceManifest,
          declaredDataClasses: synthPlusRealIntent.dataClasses,
        },
        resolver,
      ),
    ).toThrowError(SanitizedAiError);
  });

  it('6. Registered purely synthetic fixture succeeds; unregistered fixture fails', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerSyntheticFixture({
      fixtureId: 'fix-valid',
      fixtureVersion: 'v1',
      content: 'Synthetic prompt',
    });
    const policy: ProviderEligibilityPolicy = { isEligible: () => true };

    const validIntent = createBaseIntent({
      dataClasses: ['SYNTHETIC'],
      sourceManifest: [
        {
          ref: 'fix-valid',
          kind: 'SYNTHETIC_FIXTURE',
          inheritedClasses: ['SYNTHETIC'],
          ancestorRefs: [],
          scope: { type: 'SYNTHETIC_FIXTURE', fixtureId: 'fix-valid', fixtureVersion: 'v1' },
        },
      ],
      messages: [{ role: 'user', parts: [{ text: 'Synthetic prompt', sourceRef: 'fix-valid' }] }],
    });

    const res = executeOfflineGeneration(
      {
        authenticatedUserId: 'user-a',
        intent: validIntent,
        provider: 'MOCK',
        cutoffMode: 'PRE_START',
        deadlineInput: makePreStartDeadlines(),
        nowMs: NOW_MS,
      },
      { resolver, eligibilityPolicy: policy },
    );
    expect(res.provider).toBe('MOCK');

    const unregisteredIntent = createBaseIntent({
      dataClasses: ['SYNTHETIC'],
      sourceManifest: [
        {
          ref: 'fix-unknown',
          kind: 'SYNTHETIC_FIXTURE',
          inheritedClasses: ['SYNTHETIC'],
          ancestorRefs: [],
          scope: { type: 'SYNTHETIC_FIXTURE', fixtureId: 'fix-unknown', fixtureVersion: 'v1' },
        },
      ],
      messages: [{ role: 'user', parts: [{ text: 'Unregistered', sourceRef: 'fix-unknown' }] }],
    });

    expect(() =>
      executeOfflineGeneration(
        {
          authenticatedUserId: 'user-a',
          intent: unregisteredIntent,
          provider: 'MOCK',
          cutoffMode: 'PRE_START',
          deadlineInput: makePreStartDeadlines(),
          nowMs: NOW_MS,
        },
        { resolver, eligibilityPolicy: policy },
      ),
    ).toThrowError(SanitizedAiError);
  });

  it('7. Stale permit / class downgrade between attempts is denied', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-resp-1',
      recordVersion: 'v1',
      kind: 'CANDIDATE_RESPONSE',
      ancestorRefs: [],
      content: 'Synthetic candidate answer',
    });
    const policy: ProviderEligibilityPolicy = { isEligible: () => true };
    const intent = createBaseIntent();

    expect(() =>
      executeOfflineGeneration(
        {
          authenticatedUserId: 'user-a',
          intent,
          provider: 'MOCK',
          cutoffMode: 'POST_START',
          deadlineInput: makePostStartDeadlines(),
          nowMs: NOW_MS,
          permitReceipt: {
            permitId: 'permit-1',
            canonicalDataClasses: ['SYNTHETIC'],
            requestIdentity: 'stale-identity',
          },
        },
        { resolver, eligibilityPolicy: policy },
      ),
    ).toThrowError(SanitizedAiError);
  });

  it('8. PRE_START and POST_START deadline helpers fail closed on expired or NaN timestamps', () => {
    const pre = computePreStartCutoff(makePreStartDeadlines(30_000), NOW_MS, 5_000, 1_000);
    expect(pre.remainingMs).toBe(25_000);

    const post = computePostStartCutoff(makePostStartDeadlines(20_000), NOW_MS, 2_000, 1_000);
    expect(post.remainingMs).toBe(18_000);
    expect(computeEffectiveProviderTimeoutMs(30_000, post.remainingMs)).toBe(18_000);

    expect(() =>
      computePreStartCutoff({ ...makePreStartDeadlines(), readyExpiresAt: Number.NaN }, NOW_MS),
    ).toThrowError(SanitizedAiError);

    expect(() => computePostStartCutoff(makePostStartDeadlines(-1_000), NOW_MS)).toThrowError(
      SanitizedAiError,
    );

    // Zero remaining time must fail closed even if minViableCallMs is 0
    expect(() =>
      computePreStartCutoff(makePreStartDeadlines(0), NOW_MS, 0, 0),
    ).toThrowError(SanitizedAiError);
  });

  it('9. Sanitized errors never leak private rubric, prompt text, or raw source refs', () => {
    const resolver = new DeterministicFakeSourceResolver();
    const policy: ProviderEligibilityPolicy = { isEligible: () => true };
    const secretPrompt = 'SECRET_RUBRIC_CRITERIA_DO_NOT_LEAK';

    const intent = createBaseIntent({
      messages: [{ role: 'user', parts: [{ text: secretPrompt, sourceRef: 'missing-ref-id' }] }],
    });

    try {
      executeOfflineGeneration(
        {
          authenticatedUserId: 'user-a',
          intent,
          provider: 'MOCK',
          cutoffMode: 'PRE_START',
          deadlineInput: makePreStartDeadlines(),
          nowMs: NOW_MS,
        },
        { resolver, eligibilityPolicy: policy },
      );
      expect.unreachable('Expected SanitizedAiError');
    } catch (err) {
      expect(err).toBeInstanceOf(SanitizedAiError);
      const message = (err as SanitizedAiError).message;
      expect(message).not.toContain(secretPrompt);
      expect(message).not.toContain('missing-ref-id');
    }
  });

  it('10. Fallback/repair calls re-evaluate policy independently with no implicit Cloudflare enabling', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerSyntheticFixture({
      fixtureId: 'fix-1',
      fixtureVersion: 'v1',
      content: 'Synthetic',
    });

    const isEligibleSpy = vi.fn(({ provider, isFallbackOrRepair }) => {
      if (provider === 'CLOUDFLARE') return false;
      return !isFallbackOrRepair;
    });
    const policy: ProviderEligibilityPolicy = { isEligible: isEligibleSpy };

    const intent = createBaseIntent({
      dataClasses: ['SYNTHETIC'],
      sourceManifest: [
        {
          ref: 'fix-1',
          kind: 'SYNTHETIC_FIXTURE',
          inheritedClasses: ['SYNTHETIC'],
          ancestorRefs: [],
          scope: { type: 'SYNTHETIC_FIXTURE', fixtureId: 'fix-1', fixtureVersion: 'v1' },
        },
      ],
      messages: [{ role: 'user', parts: [{ text: 'Synthetic', sourceRef: 'fix-1' }] }],
    });

    expect(() =>
      executeOfflineGeneration(
        {
          authenticatedUserId: 'user-a',
          intent,
          provider: 'CLOUDFLARE',
          cutoffMode: 'PRE_START',
          deadlineInput: makePreStartDeadlines(),
          nowMs: NOW_MS,
          isFallbackOrRepair: true,
        },
        { resolver, eligibilityPolicy: policy },
      ),
    ).toThrowError(SanitizedAiError);

    expect(isEligibleSpy).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'CLOUDFLARE', isFallbackOrRepair: true }),
    );
  });

  // --- P4-AI-01a-R1 Required Regressions ---

  it('R1. Rejects valid registered synthetic fixture when part.text substitutes private text', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerSyntheticFixture({
      fixtureId: 'fix-1',
      fixtureVersion: 'v1',
      content: 'Authoritative synthetic fixture text',
    });

    expect(() =>
      resolveAndAuthorizeSourceManifest(
        {
          authenticatedUserId: 'user-a',
          interviewId: 'int-a-1',
          messages: [
            {
              role: 'user',
              parts: [{ text: 'Substituted private transcript text', sourceRef: 'fix-1' }],
            },
          ],
          descriptors: [
            {
              ref: 'fix-1',
              kind: 'SYNTHETIC_FIXTURE',
              inheritedClasses: ['SYNTHETIC'],
              ancestorRefs: [],
              scope: { type: 'SYNTHETIC_FIXTURE', fixtureId: 'fix-1', fixtureVersion: 'v1' },
            },
          ],
          declaredDataClasses: ['SYNTHETIC'],
        },
        resolver,
      ),
    ).toThrowError(SanitizedAiError);
  });

  it('R2. Rejects trusted server template when part.text substitutes unauthorized text', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerServerTemplate({
      templateId: 'tpl-sys',
      templateVersion: 'v1',
      content: 'Authoritative system prompt',
    });

    expect(() =>
      resolveAndAuthorizeSourceManifest(
        {
          authenticatedUserId: 'user-a',
          interviewId: 'int-a-1',
          messages: [
            {
              role: 'system',
              parts: [{ text: 'Injected prompt override', sourceRef: 'tpl-sys' }],
            },
          ],
          descriptors: [
            {
              ref: 'tpl-sys',
              kind: 'TRUSTED_TEMPLATE',
              inheritedClasses: [],
              ancestorRefs: [],
              scope: { type: 'SERVER_TEMPLATE', templateId: 'tpl-sys', templateVersion: 'v1' },
            },
          ],
          declaredDataClasses: [],
        },
        resolver,
      ),
    ).toThrowError(SanitizedAiError);
  });

  it('R3. Rejects derived summary when authoritative record has two ancestors but descriptor omits one', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-1',
      recordVersion: 'v1',
      kind: 'CANDIDATE_RESPONSE',
      ancestorRefs: [],
      content: 'Answer 1',
    });
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-2',
      recordVersion: 'v1',
      kind: 'CANDIDATE_DOCUMENT',
      ancestorRefs: [],
      content: 'Doc 1',
    });
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-sum',
      recordVersion: 'v1',
      kind: 'DERIVED_SUMMARY',
      ancestorRefs: ['resp-1', 'doc-1'],
      content: 'Combined summary',
    });

    expect(() =>
      resolveAndAuthorizeSourceManifest(
        {
          authenticatedUserId: 'user-a',
          interviewId: 'int-a-1',
          messages: [{ role: 'user', parts: [{ text: 'Combined summary', sourceRef: 'sum-1' }] }],
          descriptors: [
            {
              ref: 'resp-1',
              kind: 'CANDIDATE_RESPONSE',
              inheritedClasses: ['USER_TRANSCRIPT'],
              ancestorRefs: [],
              scope: {
                type: 'USER_INTERVIEW',
                userId: 'user-a',
                interviewId: 'int-a-1',
                recordId: 'rec-1',
                recordVersion: 'v1',
              },
            },
            {
              ref: 'sum-1',
              kind: 'DERIVED_SUMMARY',
              inheritedClasses: ['USER_TRANSCRIPT'],
              ancestorRefs: ['resp-1'], // Omitted 'doc-1'
              scope: {
                type: 'USER_INTERVIEW',
                userId: 'user-a',
                interviewId: 'int-a-1',
                recordId: 'rec-sum',
                recordVersion: 'v1',
              },
            },
          ],
          declaredDataClasses: ['USER_TRANSCRIPT'],
        },
        resolver,
      ),
    ).toThrowError(SanitizedAiError);
  });

  it('R4. Rejects permit reuse on same-class source substitution with unchanged descriptor count', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-resp-1',
      recordVersion: 'v1',
      kind: 'CANDIDATE_RESPONSE',
      ancestorRefs: [],
      content: 'Synthetic candidate answer',
    });
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-resp-2',
      recordVersion: 'v1',
      kind: 'CANDIDATE_RESPONSE',
      ancestorRefs: [],
      content: 'Different candidate answer',
    });

    const first = resolveAndAuthorizeSourceManifest(
      {
        authenticatedUserId: 'user-a',
        interviewId: 'int-a-1',
        messages: [{ role: 'user', parts: [{ text: 'Synthetic candidate answer', sourceRef: 'resp-a-1' }] }],
        descriptors: createBaseIntent().sourceManifest,
        declaredDataClasses: ['USER_TRANSCRIPT'],
        requestBinding: {
          operationId: 'op-001',
          generationEpoch: 1,
          attemptId: 'att-001',
          attemptNo: 1,
          provider: 'MOCK',
          purpose: 'QUESTION',
          promptVersion: '1.0.0',
          outputSchemaVersion: '1.0.0',
          maxOutputTokens: 256,
          estimatedInputTokens: 32,
          reasoningProfile: 'NO_REASONING',
          absoluteDeadlineAt: new Date(NOW_MS + 60_000).toISOString(),
        },
      },
      resolver,
    );

    const substitutedIntent = createBaseIntent({
      sourceManifest: [
        {
          ref: 'resp-a-2',
          kind: 'CANDIDATE_RESPONSE',
          inheritedClasses: ['USER_TRANSCRIPT'],
          ancestorRefs: [],
          scope: {
            type: 'USER_INTERVIEW',
            userId: 'user-a',
            interviewId: 'int-a-1',
            recordId: 'rec-resp-2',
            recordVersion: 'v1',
          },
        },
      ],
      messages: [{ role: 'user', parts: [{ text: 'Different candidate answer', sourceRef: 'resp-a-2' }] }],
    });

    expect(() =>
      executeOfflineGeneration(
        {
          authenticatedUserId: 'user-a',
          intent: substitutedIntent,
          provider: 'MOCK',
          cutoffMode: 'POST_START',
          deadlineInput: makePostStartDeadlines(),
          nowMs: NOW_MS,
          permitReceipt: {
            permitId: 'permit-1',
            canonicalDataClasses: first.canonicalDataClasses,
            requestIdentity: first.requestIdentity,
          },
        },
        { resolver, eligibilityPolicy: { isEligible: () => true } },
      ),
    ).toThrowError(SanitizedAiError);
  });

  it('R5. Rejects permit reuse when promptVersion changes with unchanged data classes', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-resp-1',
      recordVersion: 'v1',
      kind: 'CANDIDATE_RESPONSE',
      ancestorRefs: [],
      content: 'Synthetic candidate answer',
    });

    const first = resolveAndAuthorizeSourceManifest(
      {
        authenticatedUserId: 'user-a',
        interviewId: 'int-a-1',
        messages: createBaseIntent().messages,
        descriptors: createBaseIntent().sourceManifest,
        declaredDataClasses: ['USER_TRANSCRIPT'],
        requestBinding: {
          operationId: 'op-001',
          generationEpoch: 1,
          attemptId: 'att-001',
          attemptNo: 1,
          provider: 'MOCK',
          purpose: 'QUESTION',
          promptVersion: '1.0.0',
          outputSchemaVersion: '1.0.0',
          maxOutputTokens: 256,
          estimatedInputTokens: 32,
          reasoningProfile: 'NO_REASONING',
          absoluteDeadlineAt: new Date(NOW_MS + 60_000).toISOString(),
        },
      },
      resolver,
    );

    expect(() =>
      executeOfflineGeneration(
        {
          authenticatedUserId: 'user-a',
          intent: createBaseIntent({ promptVersion: '2.0.0' }),
          provider: 'MOCK',
          cutoffMode: 'POST_START',
          deadlineInput: makePostStartDeadlines(),
          nowMs: NOW_MS,
          permitReceipt: {
            permitId: 'permit-1',
            canonicalDataClasses: first.canonicalDataClasses,
            requestIdentity: first.requestIdentity,
          },
        },
        { resolver, eligibilityPolicy: { isEligible: () => true } },
      ),
    ).toThrowError(SanitizedAiError);
  });

  it('R6. Rejects permit reuse across provider or attempt changes', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-resp-1',
      recordVersion: 'v1',
      kind: 'CANDIDATE_RESPONSE',
      ancestorRefs: [],
      content: 'Synthetic candidate answer',
    });

    const first = resolveAndAuthorizeSourceManifest(
      {
        authenticatedUserId: 'user-a',
        interviewId: 'int-a-1',
        messages: createBaseIntent().messages,
        descriptors: createBaseIntent().sourceManifest,
        declaredDataClasses: ['USER_TRANSCRIPT'],
        requestBinding: {
          operationId: 'op-001',
          generationEpoch: 1,
          attemptId: 'att-001',
          attemptNo: 1,
          provider: 'MOCK',
          purpose: 'QUESTION',
          promptVersion: '1.0.0',
          outputSchemaVersion: '1.0.0',
          maxOutputTokens: 256,
          estimatedInputTokens: 32,
          reasoningProfile: 'NO_REASONING',
          absoluteDeadlineAt: new Date(NOW_MS + 60_000).toISOString(),
        },
      },
      resolver,
    );

    const receipt = {
      permitId: 'permit-1',
      canonicalDataClasses: first.canonicalDataClasses,
      requestIdentity: first.requestIdentity,
    };

    // Provider change
    expect(() =>
      executeOfflineGeneration(
        {
          authenticatedUserId: 'user-a',
          intent: createBaseIntent(),
          provider: 'GROQ',
          cutoffMode: 'POST_START',
          deadlineInput: makePostStartDeadlines(),
          nowMs: NOW_MS,
          permitReceipt: receipt,
        },
        { resolver, eligibilityPolicy: { isEligible: () => true } },
      ),
    ).toThrowError(SanitizedAiError);

    // Attempt change
    expect(() =>
      executeOfflineGeneration(
        {
          authenticatedUserId: 'user-a',
          intent: createBaseIntent({ attemptId: 'att-002', attemptNo: 2 }),
          provider: 'MOCK',
          cutoffMode: 'POST_START',
          deadlineInput: makePostStartDeadlines(),
          nowMs: NOW_MS,
          permitReceipt: receipt,
        },
        { resolver, eligibilityPolicy: { isEligible: () => true } },
      ),
    ).toThrowError(SanitizedAiError);
  });

  it('R7. Missing POST_START hardExpiryAt fails closed', () => {
    const missingHardExpiry = {
      controllerLeaseUntil: NOW_MS + 30_000,
      effectiveDeadlineAt: NOW_MS + 30_000,
      requestDeadline: NOW_MS + 30_000,
    } as unknown as PostStartDeadlineInput;

    expect(() => computePostStartCutoff(missingHardExpiry, NOW_MS)).toThrowError(SanitizedAiError);
  });

  it('R8. Malformed inputs and unexpected resolver exceptions map to sanitized errors without leaking details', () => {
    const throwingResolver: AuthoritativeSourceResolver = {
      resolveUserInterviewSource() {
        throw new Error('RAW_DB_INTERNAL_CONNECTION_STRING_LEAK');
      },
      resolveServerTemplate() {
        throw new Error('RAW_TEMPLATE_PATH_LEAK');
      },
      resolveSyntheticFixture() {
        throw new Error('RAW_FIXTURE_SECRET_LEAK');
      },
    };

    try {
      executeOfflineGeneration(
        {
          authenticatedUserId: 'user-a',
          intent: createBaseIntent(),
          provider: 'MOCK',
          cutoffMode: 'PRE_START',
          deadlineInput: makePreStartDeadlines(),
          nowMs: NOW_MS,
        },
        { resolver: throwingResolver, eligibilityPolicy: { isEligible: () => true } },
      );
      expect.unreachable('Expected SanitizedAiError');
    } catch (err) {
      expect(err).toBeInstanceOf(SanitizedAiError);
      expect((err as SanitizedAiError).message).not.toContain('RAW_DB_INTERNAL_CONNECTION_STRING_LEAK');
    }

    // Invalid cutoffMode
    expect(() =>
      executeOfflineGeneration(
        {
          authenticatedUserId: 'user-a',
          intent: createBaseIntent(),
          provider: 'MOCK',
          cutoffMode: 'INVALID_MODE' as CutoffMode,
          deadlineInput: makePreStartDeadlines(),
          nowMs: NOW_MS,
        },
        { resolver: new DeterministicFakeSourceResolver(), eligibilityPolicy: { isEligible: () => true } },
      ),
    ).toThrowError(SanitizedAiError);
  });

  // --- P4-AI-01a-R2 Mandatory Regressions ---

  it('R9. Rejects when authoritative document ancestor is replaced with a response under the same reference alias', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-resp-1',
      recordVersion: 'v1',
      kind: 'CANDIDATE_RESPONSE',
      ancestorRefs: [],
      content: 'Substituted response',
    });
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-sum-1',
      recordVersion: 'v1',
      kind: 'DERIVED_SUMMARY',
      ancestorRefs: ['anc-1'],
      authoritativeAncestors: [
        { kind: 'CANDIDATE_DOCUMENT', recordId: 'rec-doc-1', recordVersion: 'v1' },
      ],
      content: 'Summary of document',
    });

    expect(() =>
      resolveAndAuthorizeSourceManifest(
        {
          authenticatedUserId: 'user-a',
          interviewId: 'int-a-1',
          messages: [{ role: 'user', parts: [{ text: 'Summary of document', sourceRef: 'sum-1' }] }],
          descriptors: [
            {
              ref: 'anc-1',
              kind: 'CANDIDATE_RESPONSE',
              inheritedClasses: ['USER_TRANSCRIPT'],
              ancestorRefs: [],
              scope: {
                type: 'USER_INTERVIEW',
                userId: 'user-a',
                interviewId: 'int-a-1',
                recordId: 'rec-resp-1',
                recordVersion: 'v1',
              },
            },
            {
              ref: 'sum-1',
              kind: 'DERIVED_SUMMARY',
              inheritedClasses: ['USER_TRANSCRIPT'],
              ancestorRefs: ['anc-1'],
              scope: {
                type: 'USER_INTERVIEW',
                userId: 'user-a',
                interviewId: 'int-a-1',
                recordId: 'rec-sum-1',
                recordVersion: 'v1',
              },
            },
          ],
          declaredDataClasses: ['USER_TRANSCRIPT'],
        },
        resolver,
      ),
    ).toThrowError(SanitizedAiError);
  });

  it('R10. Rejects ancestor record version substitution under the same alias', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-doc-1',
      recordVersion: 'v2',
      kind: 'CANDIDATE_DOCUMENT',
      ancestorRefs: [],
      content: 'Doc v2',
    });
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-sum-1',
      recordVersion: 'v1',
      kind: 'DERIVED_SUMMARY',
      ancestorRefs: ['anc-1'],
      authoritativeAncestors: [
        { kind: 'CANDIDATE_DOCUMENT', recordId: 'rec-doc-1', recordVersion: 'v1' },
      ],
      content: 'Summary of v1',
    });

    expect(() =>
      resolveAndAuthorizeSourceManifest(
        {
          authenticatedUserId: 'user-a',
          interviewId: 'int-a-1',
          messages: [{ role: 'user', parts: [{ text: 'Summary of v1', sourceRef: 'sum-1' }] }],
          descriptors: [
            {
              ref: 'anc-1',
              kind: 'CANDIDATE_DOCUMENT',
              inheritedClasses: ['USER_DOCUMENT'],
              ancestorRefs: [],
              scope: {
                type: 'USER_INTERVIEW',
                userId: 'user-a',
                interviewId: 'int-a-1',
                recordId: 'rec-doc-1',
                recordVersion: 'v2',
              },
            },
            {
              ref: 'sum-1',
              kind: 'DERIVED_SUMMARY',
              inheritedClasses: ['USER_DOCUMENT'],
              ancestorRefs: ['anc-1'],
              scope: {
                type: 'USER_INTERVIEW',
                userId: 'user-a',
                interviewId: 'int-a-1',
                recordId: 'rec-sum-1',
                recordVersion: 'v1',
              },
            },
          ],
          declaredDataClasses: ['USER_DOCUMENT'],
        },
        resolver,
      ),
    ).toThrowError(SanitizedAiError);
  });

  it('R11. Rejects template-only request with an empty final data-class union', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerServerTemplate({
      templateId: 'tpl-sys',
      templateVersion: 'v1',
      content: 'Authoritative system prompt',
    });

    expect(() =>
      resolveAndAuthorizeSourceManifest(
        {
          authenticatedUserId: 'user-a',
          interviewId: 'int-a-1',
          messages: [
            {
              role: 'system',
              parts: [{ text: 'Authoritative system prompt', sourceRef: 'tpl-sys' }],
            },
          ],
          descriptors: [
            {
              ref: 'tpl-sys',
              kind: 'TRUSTED_TEMPLATE',
              inheritedClasses: [],
              ancestorRefs: [],
              scope: { type: 'SERVER_TEMPLATE', templateId: 'tpl-sys', templateVersion: 'v1' },
            },
          ],
          declaredDataClasses: [],
        },
        resolver,
      ),
    ).toThrowError(SanitizedAiError);
  });

  it('R12. Rejects existing permit reused with changed generation parameters', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-resp-1',
      recordVersion: 'v1',
      kind: 'CANDIDATE_RESPONSE',
      ancestorRefs: [],
      content: 'Synthetic candidate answer',
    });

    const first = resolveAndAuthorizeSourceManifest(
      {
        authenticatedUserId: 'user-a',
        interviewId: 'int-a-1',
        messages: createBaseIntent().messages,
        descriptors: createBaseIntent().sourceManifest,
        declaredDataClasses: ['USER_TRANSCRIPT'],
        requestBinding: {
          operationId: 'op-001',
          generationEpoch: 1,
          attemptId: 'att-001',
          attemptNo: 1,
          provider: 'MOCK',
          purpose: 'QUESTION',
          promptVersion: '1.0.0',
          outputSchemaVersion: '1.0.0',
          maxOutputTokens: 256,
          estimatedInputTokens: 32,
          reasoningProfile: 'NO_REASONING',
          absoluteDeadlineAt: new Date(NOW_MS + 60_000).toISOString(),
        },
      },
      resolver,
    );

    const receipt = {
      permitId: 'permit-1',
      canonicalDataClasses: first.canonicalDataClasses,
      requestIdentity: first.requestIdentity,
    };

    expect(() =>
      executeOfflineGeneration(
        {
          authenticatedUserId: 'user-a',
          intent: createBaseIntent({ maxOutputTokens: 512 }),
          provider: 'MOCK',
          cutoffMode: 'POST_START',
          deadlineInput: makePostStartDeadlines(),
          nowMs: NOW_MS,
          permitReceipt: receipt,
        },
        { resolver, eligibilityPolicy: { isEligible: () => true } },
      ),
    ).toThrowError(SanitizedAiError);
  });

  it('R13. Valid authoritative mixed-source summary remains accepted', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-resp-1',
      recordVersion: 'v1',
      kind: 'CANDIDATE_RESPONSE',
      ancestorRefs: [],
      content: 'Answer 1',
    });
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-doc-1',
      recordVersion: 'v1',
      kind: 'CANDIDATE_DOCUMENT',
      ancestorRefs: [],
      content: 'Doc 1',
    });
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-sum-1',
      recordVersion: 'v1',
      kind: 'DERIVED_SUMMARY',
      ancestorRefs: ['resp-1', 'doc-1'],
      authoritativeAncestors: [
        { kind: 'CANDIDATE_RESPONSE', recordId: 'rec-resp-1', recordVersion: 'v1' },
        { kind: 'CANDIDATE_DOCUMENT', recordId: 'rec-doc-1', recordVersion: 'v1' },
      ],
      content: 'Mixed summary',
    });

    const result = resolveAndAuthorizeSourceManifest(
      {
        authenticatedUserId: 'user-a',
        interviewId: 'int-a-1',
        messages: [{ role: 'user', parts: [{ text: 'Mixed summary', sourceRef: 'sum-1' }] }],
        descriptors: [
          {
            ref: 'resp-1',
            kind: 'CANDIDATE_RESPONSE',
            inheritedClasses: ['USER_TRANSCRIPT'],
            ancestorRefs: [],
            scope: {
              type: 'USER_INTERVIEW',
              userId: 'user-a',
              interviewId: 'int-a-1',
              recordId: 'rec-resp-1',
              recordVersion: 'v1',
            },
          },
          {
            ref: 'doc-1',
            kind: 'CANDIDATE_DOCUMENT',
            inheritedClasses: ['USER_DOCUMENT'],
            ancestorRefs: [],
            scope: {
              type: 'USER_INTERVIEW',
              userId: 'user-a',
              interviewId: 'int-a-1',
              recordId: 'rec-doc-1',
              recordVersion: 'v1',
            },
          },
          {
            ref: 'sum-1',
            kind: 'DERIVED_SUMMARY',
            inheritedClasses: ['USER_TRANSCRIPT', 'USER_DOCUMENT'],
            ancestorRefs: ['resp-1', 'doc-1'],
            scope: {
              type: 'USER_INTERVIEW',
              userId: 'user-a',
              interviewId: 'int-a-1',
              recordId: 'rec-sum-1',
              recordVersion: 'v1',
            },
          },
        ],
        declaredDataClasses: ['USER_TRANSCRIPT', 'USER_DOCUMENT'],
      },
      resolver,
    );

    expect(result.canonicalDataClasses).toEqual(['USER_TRANSCRIPT', 'USER_DOCUMENT']);
  });

  // --- P4-AI-01a-R3 Mandatory Regressions ---

  it('R14. Rejects DERIVED_SUMMARY when authoritativeAncestors is missing', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-resp-1',
      recordVersion: 'v1',
      kind: 'CANDIDATE_RESPONSE',
      ancestorRefs: [],
      content: 'Answer 1',
    });
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-sum-1',
      recordVersion: 'v1',
      kind: 'DERIVED_SUMMARY',
      ancestorRefs: ['resp-1'],
      content: 'Summary without authoritativeAncestors',
    });

    expect(() =>
      resolveAndAuthorizeSourceManifest(
        {
          authenticatedUserId: 'user-a',
          interviewId: 'int-a-1',
          messages: [
            {
              role: 'user',
              parts: [{ text: 'Summary without authoritativeAncestors', sourceRef: 'sum-1' }],
            },
          ],
          descriptors: [
            {
              ref: 'resp-1',
              kind: 'CANDIDATE_RESPONSE',
              inheritedClasses: ['USER_TRANSCRIPT'],
              ancestorRefs: [],
              scope: {
                type: 'USER_INTERVIEW',
                userId: 'user-a',
                interviewId: 'int-a-1',
                recordId: 'rec-resp-1',
                recordVersion: 'v1',
              },
            },
            {
              ref: 'sum-1',
              kind: 'DERIVED_SUMMARY',
              inheritedClasses: ['USER_TRANSCRIPT'],
              ancestorRefs: ['resp-1'],
              scope: {
                type: 'USER_INTERVIEW',
                userId: 'user-a',
                interviewId: 'int-a-1',
                recordId: 'rec-sum-1',
                recordVersion: 'v1',
              },
            },
          ],
          declaredDataClasses: ['USER_TRANSCRIPT'],
        },
        resolver,
      ),
    ).toThrowError(SanitizedAiError);
  });

  it('R15. Rejects DERIVED_SUMMARY when authoritativeAncestors is empty', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-resp-1',
      recordVersion: 'v1',
      kind: 'CANDIDATE_RESPONSE',
      ancestorRefs: [],
      content: 'Answer 1',
    });
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-sum-1',
      recordVersion: 'v1',
      kind: 'DERIVED_SUMMARY',
      ancestorRefs: ['resp-1'],
      authoritativeAncestors: [],
      content: 'Summary with empty authoritativeAncestors',
    });

    expect(() =>
      resolveAndAuthorizeSourceManifest(
        {
          authenticatedUserId: 'user-a',
          interviewId: 'int-a-1',
          messages: [
            {
              role: 'user',
              parts: [{ text: 'Summary with empty authoritativeAncestors', sourceRef: 'sum-1' }],
            },
          ],
          descriptors: [
            {
              ref: 'resp-1',
              kind: 'CANDIDATE_RESPONSE',
              inheritedClasses: ['USER_TRANSCRIPT'],
              ancestorRefs: [],
              scope: {
                type: 'USER_INTERVIEW',
                userId: 'user-a',
                interviewId: 'int-a-1',
                recordId: 'rec-resp-1',
                recordVersion: 'v1',
              },
            },
            {
              ref: 'sum-1',
              kind: 'DERIVED_SUMMARY',
              inheritedClasses: ['USER_TRANSCRIPT'],
              ancestorRefs: ['resp-1'],
              scope: {
                type: 'USER_INTERVIEW',
                userId: 'user-a',
                interviewId: 'int-a-1',
                recordId: 'rec-sum-1',
                recordVersion: 'v1',
              },
            },
          ],
          declaredDataClasses: ['USER_TRANSCRIPT'],
        },
        resolver,
      ),
    ).toThrowError(SanitizedAiError);
  });

  it('R16. Rejects DERIVED_SUMMARY when authoritativeAncestors has incomplete identity coverage', () => {
    const resolver = new DeterministicFakeSourceResolver();
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-resp-1',
      recordVersion: 'v1',
      kind: 'CANDIDATE_RESPONSE',
      ancestorRefs: [],
      content: 'Answer 1',
    });
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-doc-1',
      recordVersion: 'v1',
      kind: 'CANDIDATE_DOCUMENT',
      ancestorRefs: [],
      content: 'Doc 1',
    });
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-sum-1',
      recordVersion: 'v1',
      kind: 'DERIVED_SUMMARY',
      ancestorRefs: ['resp-1', 'doc-1'],
      authoritativeAncestors: [
        { kind: 'CANDIDATE_RESPONSE', recordId: 'rec-resp-1', recordVersion: 'v1' },
      ],
      content: 'Incomplete coverage summary',
    });

    expect(() =>
      resolveAndAuthorizeSourceManifest(
        {
          authenticatedUserId: 'user-a',
          interviewId: 'int-a-1',
          messages: [
            { role: 'user', parts: [{ text: 'Incomplete coverage summary', sourceRef: 'sum-1' }] },
          ],
          descriptors: [
            {
              ref: 'resp-1',
              kind: 'CANDIDATE_RESPONSE',
              inheritedClasses: ['USER_TRANSCRIPT'],
              ancestorRefs: [],
              scope: {
                type: 'USER_INTERVIEW',
                userId: 'user-a',
                interviewId: 'int-a-1',
                recordId: 'rec-resp-1',
                recordVersion: 'v1',
              },
            },
            {
              ref: 'doc-1',
              kind: 'CANDIDATE_DOCUMENT',
              inheritedClasses: ['USER_DOCUMENT'],
              ancestorRefs: [],
              scope: {
                type: 'USER_INTERVIEW',
                userId: 'user-a',
                interviewId: 'int-a-1',
                recordId: 'rec-doc-1',
                recordVersion: 'v1',
              },
            },
            {
              ref: 'sum-1',
              kind: 'DERIVED_SUMMARY',
              inheritedClasses: ['USER_TRANSCRIPT', 'USER_DOCUMENT'],
              ancestorRefs: ['resp-1', 'doc-1'],
              scope: {
                type: 'USER_INTERVIEW',
                userId: 'user-a',
                interviewId: 'int-a-1',
                recordId: 'rec-sum-1',
                recordVersion: 'v1',
              },
            },
          ],
          declaredDataClasses: ['USER_TRANSCRIPT', 'USER_DOCUMENT'],
        },
        resolver,
      ),
    ).toThrowError(SanitizedAiError);
  });
});
