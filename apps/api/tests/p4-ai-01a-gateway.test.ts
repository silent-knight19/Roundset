import { describe, expect, it, vi } from 'vitest';
import {
  computeEffectiveProviderTimeoutMs,
  computePostStartCutoff,
  computePreStartCutoff,
  DeterministicFakeSourceResolver,
  executeOfflineGeneration,
  GenerationIntent,
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

function makePostStartDeadlines(offsetMs = 60_000) {
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
    });
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-sum-1',
      recordVersion: 'v1',
      kind: 'DERIVED_SUMMARY',
      ancestorRefs: ['resp-a-1'],
    });

    const policy: ProviderEligibilityPolicy = {
      isEligible: () => true,
    };

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

    // Spoofed scope claiming int-a-1 while resolver only has int-a-other
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
      messages: [{ role: 'user', parts: [{ text: 'Spoofed', sourceRef: 'spoofed' }] }],
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
    });

    // Missing/dangling ancestor
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

    // Cyclic ancestry
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-sum-2',
      recordVersion: 'v1',
      kind: 'DERIVED_SUMMARY',
      ancestorRefs: ['sum-1'],
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
    });
    resolver.registerUserInterviewSource({
      userId: 'user-a',
      interviewId: 'int-a-1',
      recordId: 'rec-doc-1',
      recordVersion: 'v1',
      kind: 'CANDIDATE_DOCUMENT',
      ancestorRefs: [],
    });
    resolver.registerSyntheticFixture({
      fixtureId: 'fix-1',
      fixtureVersion: 'v1',
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

    // Missing USER_DOCUMENT permission denies
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

    // Synthetic + real mixture denies
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
    resolver.registerSyntheticFixture({ fixtureId: 'fix-valid', fixtureVersion: 'v1' });
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
      computePreStartCutoff(
        { ...makePreStartDeadlines(), readyExpiresAt: Number.NaN },
        NOW_MS,
      ),
    ).toThrowError(SanitizedAiError);

    expect(() =>
      computePostStartCutoff(makePostStartDeadlines(-1_000), NOW_MS),
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
    resolver.registerSyntheticFixture({ fixtureId: 'fix-1', fixtureVersion: 'v1' });

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
});
