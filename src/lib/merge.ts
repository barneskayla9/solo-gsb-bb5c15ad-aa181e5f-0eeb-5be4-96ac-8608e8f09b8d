/**
 * 短句合并：把被 SRT 切成数条的相邻短句按用户参数重新分组（纯函数，可单测）。
 *
 * 只允许合并**时间不重叠且间隔不超过「相邻可合并最大间隔」**的相邻条目；
 * 合并组取**首条起点、末条终点**；组文本 = 各条文本去首尾空白后以单个空格连接
 * （空文本条目不产生多余分隔符），字数按 **Unicode 字素簇**（含连接用空格）计数。
 *
 * 超出「合并后最长时长」或「最大字素数」的条目**不得参与合并**：它们可以作为
 * 单条结果保留，但任何包含它们的多分组合并边都不可行。
 *
 * 对整份字幕全局选择分组，目标严格优先：
 *  1. 最短化结果中短于「短字幕阈值」的条数；
 *  2. 再最小化被合并掉的条数（= 原条数 − 结果条数）；
 *  3. 同分取更早断点（断点序列按时间序字典序最小）。
 *
 * 求最优分组：时间序上的每条条目是一个顶点，分组 = 顶点集合的一个划分，
 * 相邻区间 [i, j) 为可行合并边（含始终可行的单条边）。DP 前缀 [0, j) 只保留
 * 「短句数最少 → 被合并掉条数最少 → 断点序列更早」的一个状态，并列时直接比较
 * 前驱链（同分时两链断点个数必然相等）。组可行性随右端点单调，配合坏对 /
 * 超限前缀和使整体为 O(n²)；单条边始终存在，方案永远可行。
 */

import type { Cue } from '../types';
import { countGraphemes } from './readingSpeed';

/** 短句合并参数（秒 / 字素数） */
export interface MergeOptions {
  /** 短字幕阈值：结果条目时长严格小于该值即记为一条短句（秒） */
  shortThresholdSec: number;
  /** 相邻可合并最大间隔：间隔严格小于等于该值才可合并（秒） */
  maxGapSec: number;
  /** 合并后最长时长：合并组时长严格大于该值不可行（秒） */
  maxDurationSec: number;
  /** 合并后最大字素数：组文本字素簇数严格大于该值不可行 */
  maxGraphemes: number;
}

/** 参数夹取范围（与面板输入范围一致） */
export const MERGE_SHORT_MIN = 0.1;
export const MERGE_SHORT_MAX = 10;
export const MERGE_GAP_MIN = 0;
export const MERGE_GAP_MAX = 5;
export const MERGE_DURATION_MIN = 0.5;
export const MERGE_DURATION_MAX = 60;
export const MERGE_GRAPHEMES_MIN = 1;
export const MERGE_GRAPHEMES_MAX = 500;
/** 规模保护：超过该条数不做 O(n²) 分组求解（典型电影字幕远小于此） */
export const MAX_MERGE_CUES = 5000;

export const DEFAULT_MERGE_OPTIONS: MergeOptions = {
  shortThresholdSec: 1,
  maxGapSec: 0.3,
  maxDurationSec: 7,
  maxGraphemes: 42
};

/** 单条不得参与合并的原因分类 */
export type MergeExcludeKind = 'duration' | 'graphemes';

/** 单条字幕的预览成员（时间序） */
export interface MergeMember {
  cueId: string;
  /** 列表序号（1-based，时间序） */
  index: number;
  start: number;
  end: number;
  /** 原始文本（未改动） */
  text: string;
  /** 去首尾空白后的文本 */
  trimmed: string;
  /** trim 后字素簇数 */
  chars: number;
  /** 时长（毫秒） */
  durationMs: number;
  /** true = 该条自身已超出最长时长 / 最大字素数，不得参与任何合并 */
  excluded: boolean;
  /** 不得参与合并的原因分类（excluded 时非空） */
  excludeKind: MergeExcludeKind | null;
  /** 不得参与合并的说明文案（excluded 时非空） */
  excludeReason: string | null;
}

/** 一个结果分组（单条或多条合并）的预览 */
export interface MergeGroup {
  /** 组成成员（时间序） */
  members: MergeMember[];
  /** 组起点（首条起点，秒） */
  start: number;
  /** 组终点（末条终点，秒） */
  end: number;
  /** 组时长（毫秒） */
  durationMs: number;
  /** 组文本：trim 后以单个空格连接 */
  text: string;
  /** 组字素簇数（含连接空格） */
  chars: number;
  /** true = 多条合并；false = 单条保留 */
  merged: boolean;
  /** true = 结果时长仍严格短于短字幕阈值 */
  short: boolean;
  /**
   * 单条保留且未并入任何合并组的原因（仅用于预览说明）：
   * 自身超限 / 与相邻条目重叠或间隔超限 / 并入相邻后受最长时长 / 字素数限制；
   * 正常单条（无需合并）为 null。
   */
  retainReason: string | null;
}

export interface MergePlan {
  options: MergeOptions;
  /** 时间序结果分组（应用后即该顺序） */
  groups: MergeGroup[];
  /** 结果条数 */
  resultCount: number;
  /** 原条数 */
  sourceCount: number;
  /** 被合并掉的条数（原条数 − 结果条数） */
  mergedAway: number;
  /** 真正发生合并的分组数（成员 ≥ 2） */
  mergedGroupCount: number;
  /** 结果中仍短于阈值的条数 */
  remainingShort: number;
  /** 自身超限、不得参与合并的条数 */
  excludedCount: number;
  /** 规模超限时为 true：不做分组，全部按单条展示 */
  tooLarge: boolean;
}

/* ---------------- 参数 ---------------- */

function clampNum(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/** 归一化参数（容错外部输入） */
export function normalizeMergeOptions(input: Partial<MergeOptions>): MergeOptions {
  return {
    shortThresholdSec: clampNum(input.shortThresholdSec ?? DEFAULT_MERGE_OPTIONS.shortThresholdSec, MERGE_SHORT_MIN, MERGE_SHORT_MAX, DEFAULT_MERGE_OPTIONS.shortThresholdSec),
    maxGapSec: clampNum(input.maxGapSec ?? DEFAULT_MERGE_OPTIONS.maxGapSec, MERGE_GAP_MIN, MERGE_GAP_MAX, DEFAULT_MERGE_OPTIONS.maxGapSec),
    maxDurationSec: clampNum(input.maxDurationSec ?? DEFAULT_MERGE_OPTIONS.maxDurationSec, MERGE_DURATION_MIN, MERGE_DURATION_MAX, DEFAULT_MERGE_OPTIONS.maxDurationSec),
    maxGraphemes: Math.round(
      clampNum(input.maxGraphemes ?? DEFAULT_MERGE_OPTIONS.maxGraphemes, MERGE_GRAPHEMES_MIN, MERGE_GRAPHEMES_MAX, DEFAULT_MERGE_OPTIONS.maxGraphemes)
    )
  };
}

/* ---------------- 组文本 ---------------- */

/** 各条 trim 后以单个空格连接（空文本不产生多余分隔符），整体再去首尾空白 */
export function joinMergeTexts(trimmed: string[]): string {
  return trimmed.filter((t) => t.length > 0).join(' ').trim();
}

/* ---------------- 可行性（毫秒整数域，吸收浮点误差） ---------------- */

interface EdgeInfo {
  /** 该相邻对是否满足「不重叠且间隔不超限」 */
  pairOk: boolean;
  /** 不满足 pairOk 时的说明 */
  pairReason: string | null;
}

/**
 * 检查时间序相邻两条是否可作为合并边的内部对：
 * 不重叠（next.start ≥ prev.end）且间隔（next.start − prev.end）≤ 最大间隔。
 * 端点相接（间隔 0）允许；所有时间按毫秒整数比较。
 */
export function inspectMergePair(
  prev: Pick<Cue, 'start' | 'end'>,
  next: Pick<Cue, 'start' | 'end'>,
  maxGapMs: number
): EdgeInfo {
  const prevEnd = Math.round(prev.end * 1000);
  const nextStart = Math.round(next.start * 1000);
  const gap = nextStart - prevEnd;
  if (gap < 0) {
    return { pairOk: false, pairReason: `与下一条时间重叠 ${(-gap).toFixed(0)}ms，不能合并` };
  }
  if (gap > maxGapMs) {
    return { pairOk: false, pairReason: `与相邻条目间隔 ${(gap / 1000).toFixed(3)}s 超过最大间隔 ${(maxGapMs / 1000).toFixed(3)}s` };
  }
  return { pairOk: true, pairReason: null };
}

/* ---------------- DP ---------------- */

interface Node {
  /** 覆盖到的前缀末尾位置（条目下标，exclusive 语义上即 j） */
  end: number;
  /** 最后一组起点 i */
  start: number;
  /** 前驱节点（i 位置的最优前缀）；null = 起始空节点 */
  pred: Node | null;
  /** 累计短句数 */
  short: number;
  /** 累计被合并掉的条数 */
  mergedAway: number;
}

/** 两候选的断点序列（组边界，不含 0 与 n）字典序：a 更早返回 true */
function breaksEarlier(a: Node, b: Node): boolean {
  // 同 (short, mergedAway) 的两链组内条目数总和相同 -> 断点个数相同，逐对比较即可
  const xa: number[] = [];
  const xb: number[] = [];
  let p: Node | null = a;
  while (p && p.pred) {
    xa.push(p.start);
    p = p.pred;
  }
  p = b;
  while (p && p.pred) {
    xb.push(p.start);
    p = p.pred;
  }
  for (let k = xa.length - 1, m = xb.length - 1; k >= 0 && m >= 0; k -= 1, m -= 1) {
    if (xa[k] !== xb[m]) return xa[k] < xb[m];
  }
  return false;
}

/** 候选是否严格优于当前最优（短句更少 → 被合并掉更少 → 断点更早） */
function better(cand: Node, cur: Node | null): boolean {
  if (!cur) return true;
  if (cand.short !== cur.short) return cand.short < cur.short;
  if (cand.mergedAway !== cur.mergedAway) return cand.mergedAway < cur.mergedAway;
  return breaksEarlier(cand, cur);
}

interface Prepared {
  startMs: Int32Array;
  endMs: Int32Array;
  chars: Int32Array;
  /** 带连接空格的文本长度贡献前缀和：trim 非空条目 = chars+1，空条目 = 0 */
  weightedPrefix: Int32Array;
  excluded: Uint8Array;
  /** 自身超限前缀和：区间 [i,j) 内超线条目数 = excludedPrefix[j]-excludedPrefix[i] */
  excludedPrefix: Int32Array;
  /**
   * 坏对前缀和：badPrefix[k] = 组内对下标 t ∈ [0, k) 的坏对数（对 t 连接 t 与 t+1）。
   * 区间 [i,j) 的内部对为 t ∈ [i, j-2]，坏对数 = badPrefix[j-1] - badPrefix[i]。
   */
  badPrefix: Int32Array;
}

function prepare(cues: Cue[], maxGapMs: number): Prepared {
  const n = cues.length;
  const startMs = new Int32Array(n);
  const endMs = new Int32Array(n);
  const chars = new Int32Array(n);
  const weightedPrefix = new Int32Array(n + 1);
  const excluded = new Uint8Array(n);
  const excludedPrefix = new Int32Array(n + 1);
  const badPrefix = new Int32Array(n + 1);
  for (let i = 0; i < n; i += 1) {
    startMs[i] = Math.round(cues[i].start * 1000);
    endMs[i] = Math.round(cues[i].end * 1000);
    const t = cues[i].text.trim();
    const c = countGraphemes(t);
    chars[i] = c;
    weightedPrefix[i + 1] = weightedPrefix[i] + (t.length > 0 ? c + 1 : 0);
  }
  for (let i = 0; i < n; i += 1) {
    const bad = i + 1 < n && !inspectMergePair(cues[i], cues[i + 1], maxGapMs).pairOk ? 1 : 0;
    badPrefix[i + 1] = badPrefix[i] + bad;
  }
  return { startMs, endMs, chars, weightedPrefix, excluded, excludedPrefix, badPrefix };
}

/** 区间 [i, j) 的组字素簇数（连接空格计入；全空文本为 0） */
function groupChars(pre: Prepared, i: number, j: number): number {
  const w = pre.weightedPrefix[j] - pre.weightedPrefix[i];
  return w === 0 ? 0 : w - 1;
}

/**
 * 最优分组主过程：调用方已在 pre.excluded / excludedPrefix 中标记「自身超限」条目。
 */
function solve(cues: Cue[], options: MergeOptions, pre: Prepared): { bounds: number[] } {
  const n = cues.length;
  const maxDurMs = Math.round(options.maxDurationSec * 1000);
  const shortMs = Math.round(options.shortThresholdSec * 1000);

  // dp[j]：覆盖前 j 条的最优前缀节点；dp[0] = 空节点
  const dp: (Node | null)[] = new Array(n + 1).fill(null);
  dp[0] = { end: 0, start: 0, pred: null, short: 0, mergedAway: 0 };

  for (let i = 0; i < n; i += 1) {
    const predNode = dp[i];
    if (!predNode) continue;
    // 单条边始终可行
    const singleDur = pre.endMs[i] - pre.startMs[i];
    const single: Node = {
      end: i + 1,
      start: i,
      pred: predNode,
      short: predNode.short + (singleDur < shortMs ? 1 : 0),
      mergedAway: predNode.mergedAway
    };
    if (better(single, dp[i + 1])) dp[i + 1] = single;

    // 自身超限的条目不向外延伸多分组合并边
    if (pre.excluded[i]) continue;

    // 从 i+1 起延伸：组 [i, j)，j 从 i+2（至少两条）开始
    for (let j = i + 2; j <= n; j += 1) {
      // 区间内任一坏对（重叠 / 间隔超限）即不可行；坏对数随 j 单调不减
      if (pre.badPrefix[j - 1] - pre.badPrefix[i] > 0) break;
      // 成员自身超限即不可行（随 j 单调不减）
      if (pre.excludedPrefix[j] - pre.excludedPrefix[i] > 0) break;
      // 组时长：首条起点 -> 末条终点（pairOk 保证内部不重叠，随 j 单调不减）
      const dur = pre.endMs[j - 1] - pre.startMs[i];
      if (dur > maxDurMs) break;
      // 组字素数（随 j 单调不减）
      if (groupChars(pre, i, j) > options.maxGraphemes) break;

      const groupSize = j - i;
      const node: Node = {
        end: j,
        start: i,
        pred: predNode,
        short: predNode.short + (dur < shortMs ? 1 : 0),
        mergedAway: predNode.mergedAway + (groupSize - 1)
      };
      if (better(node, dp[j])) dp[j] = node;
    }
  }

  // 回溯断点（输出为升序边界 [0, ..., n]）
  const tail: number[] = [];
  let cur: Node | null = dp[n];
  while (cur && cur.pred) {
    tail.push(cur.end);
    cur = cur.pred;
  }
  tail.reverse();
  return { bounds: [0, ...tail] };
}

/* ---------------- 预览构建 ---------------- */

function buildMembers(
  cues: Cue[],
  options: MergeOptions,
  pre: Prepared
): MergeMember[] {
  const maxDurMs = Math.round(options.maxDurationSec * 1000);
  return cues.map((cue, i) => {
    const trimmed = cue.text.trim();
    const chars = pre.chars[i];
    const durationMs = pre.endMs[i] - pre.startMs[i];
    let excludeKind: MergeExcludeKind | null = null;
    let excludeReason: string | null = null;
    if (durationMs > maxDurMs) {
      excludeKind = 'duration';
      excludeReason = `单条时长 ${(durationMs / 1000).toFixed(3)}s 已超过合并后最长时长 ${options.maxDurationSec.toFixed(3)}s，保留单条不参与合并`;
    } else if (chars > options.maxGraphemes) {
      excludeKind = 'graphemes';
      excludeReason = `单条文本 ${chars} 字素已超过最大字素数 ${options.maxGraphemes}，保留单条不参与合并`;
    }
    return {
      cueId: cue.id,
      index: i + 1,
      start: cue.start,
      end: cue.end,
      text: cue.text,
      trimmed,
      chars,
      durationMs,
      excluded: excludeKind !== null,
      excludeKind,
      excludeReason
    };
  });
}

/**
 * 为单条保留的条目生成「为什么没被合并」的说明（仅预览用）。
 * 优先给出自身超限原因；否则检查与左 / 右相邻原始条目直接合并的阻碍。
 */
function retainReasonFor(
  cues: Cue[],
  pre: Prepared,
  members: MergeMember[],
  options: MergeOptions,
  i: number,
  shortMs: number
): string | null {
  const m = members[i];
  if (m.excluded) return m.excludeReason;
  if (m.durationMs >= shortMs) return null; // 本就不短：无需合并

  const maxGapMs = Math.round(options.maxGapSec * 1000);
  const maxDurMs = Math.round(options.maxDurationSec * 1000);

  // 与左侧直接相邻：找出第一个阻碍
  if (i > 0) {
    const edge = inspectMergePair(cues[i - 1], cues[i], maxGapMs);
    if (!edge.pairOk) return edge.pairReason;
    if (pre.excluded[i - 1]) return `上一条 #${i} 自身超出时长 / 字素限制，不得参与合并`;
    const dur = pre.endMs[i] - pre.startMs[i - 1];
    if (dur > maxDurMs) return `并入上一条后时长 ${(dur / 1000).toFixed(3)}s 超过最长时长 ${options.maxDurationSec.toFixed(3)}s`;
    const leftChars = groupChars(pre, i - 1, i + 1);
    if (leftChars > options.maxGraphemes) return `并入上一条后 ${leftChars} 字素超过最大字素数 ${options.maxGraphemes}`;
  }
  // 与右侧直接相邻：找出第一个阻碍
  if (i + 1 < cues.length) {
    const edge = inspectMergePair(cues[i], cues[i + 1], maxGapMs);
    if (!edge.pairOk) return edge.pairReason;
    if (pre.excluded[i + 1]) return `下一条 #${i + 2} 自身超出时长 / 字素限制，不得参与合并`;
    const dur = pre.endMs[i + 1] - pre.startMs[i];
    if (dur > maxDurMs) return `并入下一条后时长 ${(dur / 1000).toFixed(3)}s 超过最长时长 ${options.maxDurationSec.toFixed(3)}s`;
    const rightChars = groupChars(pre, i, i + 2);
    if (rightChars > options.maxGraphemes) return `并入下一条后 ${rightChars} 字素超过最大字素数 ${options.maxGraphemes}`;
  }
  // 左 / 右直接合并都可行，单条仍为最优分组结果（如两侧并入后仍短、需让断点更早等），
  // 属于全局权衡，而非该条无法参与合并
  return null;
}

/**
 * 计算整份字幕的短句合并预览。纯只读：不修改任何字幕；
 * 字幕或参数变化时由调用方重新调用。
 */
export function buildMergePlan(cuesInput: Cue[], rawOptions: Partial<MergeOptions>): MergePlan {
  const options = normalizeMergeOptions(rawOptions);
  const sorted = [...cuesInput].sort((a, b) => a.start - b.start || a.end - b.end);
  const n = sorted.length;
  const gapMs = Math.round(options.maxGapSec * 1000);
  const maxDurMs = Math.round(options.maxDurationSec * 1000);
  const shortMs = Math.round(options.shortThresholdSec * 1000);

  const pre = prepare(sorted, gapMs);
  for (let i = 0; i < n; i += 1) {
    const durationMs = pre.endMs[i] - pre.startMs[i];
    if (durationMs > maxDurMs || pre.chars[i] > options.maxGraphemes) pre.excluded[i] = 1;
    pre.excludedPrefix[i + 1] = pre.excludedPrefix[i] + pre.excluded[i];
  }
  const members = buildMembers(sorted, options, pre);

  const tooLarge = n > MAX_MERGE_CUES;
  const bounds = tooLarge ? Array.from({ length: n + 1 }, (_, k) => k) : solve(sorted, options, pre).bounds;

  const groups: MergeGroup[] = [];
  let mergedAway = 0;
  let mergedGroupCount = 0;
  let remainingShort = 0;
  let excludedCount = 0;
  for (let i = 0; i < n; i += 1) if (pre.excluded[i]) excludedCount += 1;

  for (let g = 0; g + 1 < bounds.length; g += 1) {
    const from = bounds[g];
    const to = bounds[g + 1];
    const groupMembers = members.slice(from, to);
    const start = sorted[from].start;
    const end = sorted[to - 1].end;
    const durationMs = Math.round((end - start) * 1000);
    const text = joinMergeTexts(groupMembers.map((m) => m.trimmed));
    const chars = countGraphemes(text);
    const merged = to - from >= 2;
    const short = durationMs < shortMs;
    if (merged) {
      mergedAway += to - from - 1;
      mergedGroupCount += 1;
    }
    if (short) remainingShort += 1;
    const retainReason = !merged ? retainReasonFor(sorted, pre, members, options, from, shortMs) : null;
    groups.push({ members: groupMembers, start, end, durationMs, text, chars, merged, short, retainReason });
  }

  return {
    options,
    groups,
    resultCount: groups.length,
    sourceCount: n,
    mergedAway,
    mergedGroupCount,
    remainingShort,
    excludedCount,
    tooLarge
  };
}

/**
 * 把合并计划应用为完整字幕数组（新数组）：
 * 合并组以**首条 id** 作为结果 id、取首条起点 / 末条终点、连接文本；
 * 未合并的单条保持原对象引用。没有任何合并时返回 null。
 * 结果按时间序排列。
 */
export function applyMerge(cues: Cue[], plan: MergePlan): Cue[] | null {
  if (plan.mergedAway === 0) return null;
  const byId = new Map(cues.map((c) => [c.id, c]));
  const out: Cue[] = [];
  for (const group of plan.groups) {
    if (!group.merged) {
      out.push(byId.get(group.members[0].cueId) ?? {
        id: group.members[0].cueId,
        start: group.start,
        end: group.end,
        text: group.members[0].text
      });
      continue;
    }
    out.push({
      id: group.members[0].cueId,
      start: group.start,
      end: group.end,
      text: group.text
    });
  }
  return out;
}
