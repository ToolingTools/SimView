import {
  type AccessibilityNode,
  type AccessibilitySelector,
  type AccessibilitySnapshot,
  accessibilitySelectorSchema,
  flattenAccessibilityTree,
} from "@simview/contracts";
import { nativeTapRecovery, type SimViewSession } from "./session";

export type SemanticTextAction = { type: "clear_text" } | { type: "replace_text"; text: string };

function stableTextSelector(target: AccessibilityNode): AccessibilitySelector {
  if (target.testID || target.identifier) {
    return accessibilitySelectorSchema.parse({
      identifier: target.testID ?? target.identifier,
    });
  }
  if (target.placeholder) {
    return accessibilitySelectorSchema.parse({ placeholder: target.placeholder });
  }
  if (target.label || target.title) {
    return accessibilitySelectorSchema.parse({
      name: target.label ?? target.title,
      ...(target.role ? { role: target.role } : {}),
    });
  }
  return accessibilitySelectorSchema.parse({ role: target.role });
}

async function stableTextObservation(session: SimViewSession) {
  let observation = await session.accessibilityObserve({
    scope: "visible",
    maxWaitMs: 500,
    requireChange: false,
  });
  if (!observation.stable) {
    observation = await session.accessibilityObserve({
      scope: "visible",
      maxWaitMs: 0,
      requireChange: false,
    });
  }
  return observation;
}

type NormalizedFrame = NonNullable<NonNullable<AccessibilityNode["frame"]>["normalized"]>;

function containsPoint(frame: NormalizedFrame, point: { x: number; y: number }): boolean {
  return (
    point.x >= frame.x &&
    point.x <= frame.x + frame.width &&
    point.y >= frame.y &&
    point.y <= frame.y + frame.height
  );
}

function overlapRatio(left: NormalizedFrame, right: NormalizedFrame): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  );
  const smallestArea = Math.min(left.width * left.height, right.width * right.height);
  return smallestArea > 0 ? (width * height) / smallestArea : 0;
}

function sameRole(candidate: AccessibilityNode, target: AccessibilityNode): boolean {
  return (candidate.role ?? candidate.roleDescription) === (target.role ?? target.roleDescription);
}

function correlateTextTarget(
  snapshot: AccessibilitySnapshot,
  target: AccessibilityNode,
  point: { x: number; y: number },
): { target?: AccessibilityNode; matchCount: number; correlatedBy: string[] } {
  const nodes = flattenAccessibilityTree(snapshot.root).filter(
    (candidate) =>
      candidate.enabled !== false && candidate.hidden !== true && sameRole(candidate, target),
  );
  const identifier = target.testID ?? target.identifier;
  if (identifier) {
    const matches = nodes.filter(
      (candidate) => (candidate.testID ?? candidate.identifier) === identifier,
    );
    return {
      ...(matches.length === 1 ? { target: matches[0] } : {}),
      matchCount: matches.length,
      correlatedBy: ["identifier", "role"],
    };
  }
  const name = target.label ?? target.title;
  if (name) {
    const matches = nodes.filter((candidate) => (candidate.label ?? candidate.title) === name);
    return {
      ...(matches.length === 1 ? { target: matches[0] } : {}),
      matchCount: matches.length,
      correlatedBy: ["name", "role"],
    };
  }

  const containing = nodes.filter((candidate) => {
    const frame = candidate.frame?.normalized;
    return frame ? containsPoint(frame, point) : false;
  });
  if (containing.length === 1) {
    return {
      ...(containing[0] ? { target: containing[0] } : {}),
      matchCount: 1,
      correlatedBy: ["role", "point"],
    };
  }
  const originalFrame = target.frame?.normalized;
  const overlapping = originalFrame
    ? nodes.filter((candidate) => {
        const frame = candidate.frame?.normalized;
        return frame ? overlapRatio(originalFrame, frame) >= 0.5 : false;
      })
    : [];
  return {
    ...(overlapping.length === 1 ? { target: overlapping[0] } : {}),
    matchCount: overlapping.length || containing.length,
    correlatedBy: ["role", "frame"],
  };
}

async function observeTextTarget(
  session: SimViewSession,
  target: AccessibilityNode,
  point: { x: number; y: number },
) {
  const observation = await stableTextObservation(session);
  const correlated = correlateTextTarget(observation.snapshot, target, point);
  return {
    observation,
    ...correlated,
  };
}

function isTextCleared(target: AccessibilityNode | undefined): boolean {
  return Boolean(target && (!target.value || target.value === target.placeholder));
}

async function clearTextWithVerification(
  session: SimViewSession,
  target: AccessibilityNode,
  point: { x: number; y: number },
  currentValue: string,
) {
  await session.dispatchInput({ method: "input.key", params: { key: "select-all" } });
  await session.dispatchInput({ method: "input.key", params: { key: "delete" } });
  let result = await observeTextTarget(session, target, point);
  let cleared = isTextCleared(result.target);
  if (!cleared && result.target && currentValue.length > 0) {
    await session.dispatchInput({
      method: "input.key",
      params: { key: "arrow-right", repeat: Math.min(100, currentValue.length + 1) },
    });
    await session.dispatchInput({
      method: "input.key",
      params: { key: "delete", repeat: Math.min(100, currentValue.length) },
    });
    result = await observeTextTarget(session, target, point);
    cleared = isTextCleared(result.target);
  }
  if (!cleared && result.target) {
    for (let tap = 0; tap < 3; tap += 1) {
      await session.dispatchInput({ method: "input.tap", params: point });
    }
    await session.dispatchInput({ method: "input.key", params: { key: "delete" } });
    result = await observeTextTarget(session, target, point);
    cleared = isTextCleared(result.target);
  }
  return { ...result, cleared };
}

export async function dispatchSemanticTextAction(
  session: SimViewSession,
  action: SemanticTextAction,
  selector: AccessibilitySelector,
): Promise<Record<string, unknown>> {
  const resolution = await session.resolveNativeTap(selector);
  if (!resolution.accepted || !resolution.point || !resolution.target) {
    return {
      ...resolution,
      accepted: false,
      safeToContinue: false,
      inputDispatched: false,
      ...nativeTapRecovery(resolution),
      interaction: resolution,
    };
  }

  const stableSelector = stableTextSelector(resolution.target);
  const focusReceipt = await session.dispatchInput({
    method: "input.tap",
    params: resolution.point,
  });
  const currentValue = resolution.target.value ?? "";
  if (action.type === "clear_text") {
    const clearResult = await clearTextWithVerification(
      session,
      resolution.target,
      resolution.point,
      currentValue,
    );
    if (!clearResult.observation.stable || !clearResult.cleared) {
      return {
        accepted: false,
        safeToContinue: false,
        inputDispatched: true,
        code: "text_clear_unconfirmed",
        retryable: false,
        retryInput: false,
        retryObservation: !clearResult.observation.stable || !clearResult.target,
        interaction: { ...resolution, receipt: focusReceipt },
        verification: {
          stable: clearResult.observation.stable,
          selector: stableSelector,
          matchCount: clearResult.matchCount,
          correlatedBy: clearResult.correlatedBy,
          value: clearResult.target?.value,
        },
      };
    }
    return {
      accepted: true,
      safeToContinue: true,
      inputDispatched: true,
      interaction: { ...resolution, receipt: focusReceipt },
      verification: { stable: true, selector: stableSelector, value: "" },
    };
  }

  // A correct final value proves that select-all/delete succeeded, so the
  // normal replacement path needs only one post-write snapshot.
  await session.dispatchInput({ method: "input.key", params: { key: "select-all" } });
  await session.dispatchInput({ method: "input.key", params: { key: "delete" } });
  await session.dispatchInput({ method: "input.typeText", params: { text: action.text } });
  let replaceResult = await observeTextTarget(session, resolution.target, resolution.point);
  let replaced = replaceResult.observation.stable && replaceResult.target?.value === action.text;

  // Retry input internally only when a stable snapshot uniquely confirms that
  // this same field has the wrong value. An absent or ambiguous target is an
  // observation problem and must never cause input to be repeated.
  if (replaceResult.observation.stable && replaceResult.target && !replaced) {
    await session.dispatchInput({ method: "input.tap", params: resolution.point });
    const clearResult = await clearTextWithVerification(
      session,
      resolution.target,
      resolution.point,
      replaceResult.target.value ?? currentValue,
    );
    if (clearResult.observation.stable && clearResult.cleared) {
      await session.dispatchInput({ method: "input.typeText", params: { text: action.text } });
      replaceResult = await observeTextTarget(session, resolution.target, resolution.point);
      replaced = replaceResult.observation.stable && replaceResult.target?.value === action.text;
    } else {
      replaceResult = clearResult;
    }
  }
  return {
    accepted: replaced,
    safeToContinue: replaced,
    inputDispatched: true,
    ...(!replaced
      ? {
          code: "text_replacement_unconfirmed",
          retryable: false,
          retryInput: false,
          retryObservation: !replaceResult.observation.stable || !replaceResult.target,
        }
      : {}),
    interaction: { ...resolution, receipt: focusReceipt },
    verification: {
      stable: replaceResult.observation.stable,
      selector: stableSelector,
      matchCount: replaceResult.matchCount,
      correlatedBy: replaceResult.correlatedBy,
      expectedValue: action.text,
      actualValue: replaceResult.target?.value,
    },
  };
}
