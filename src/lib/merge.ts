/**
 * 短句合并：把被切成数条的相邻短字幕按全局最优分组合并为一条（纯函数，可单测）。
 *
 * 只合并**时间不重叠且间隔不超过 maxGapMs** 的相邻条目；每个合并组：
 *  - 时间码取首条起点、末条终点；
 *  - 文本为各条文本去首尾空白后以单个 ASCII 空格连接（再去整体首尾空白）；
 *  - 时长（末条终点 − 首条起点，毫秒）不得超过 maxDurationMs；
 *  - 连接后文本的 Unicode 字素簇数不得超过 maxChars。
 *
 * 单条原文始终可保留：自身时长超过合并后最长时长、或自身字数超过最大字素数的
 * 条目**不得参与合并**（预览中给出原因，只以原文单条形式保留）。
 *
 * 对整份字幕**全局**选择分组（时间序上的分割点规划），严格优先级：
 *  1. 最小化合并结果中「短于短字幕阈值」的条数（短组：时长严格小于 shortMs）；
 *  2. 在 1 的同分里最小化被合并掉的条数（等价于最大化结果组数 / 最小化总合并动作）；
 *  3. 仍同分，取**断点序列字典序最小**（同样是长度 g+1 的断点向量，逐位比较，
 *     断点尽量靠前——更早被合并）。
 *
 * 用按「组数」分层的动态规划求解：layers[g][j] = 用恰好 g 个组合法覆盖前 j 条时
 * 的最优状态（短路条数, 前驱组起点, 同层断点序列字典序名次）。同层名次在该层
 * 状态全部产生后按（前驱层名次, 本组末位置）指派，使并列比较为 O(1)。
 */

import type { Cue } from '../types';
import { countGraphemes } from './readingSpeed';

/** 短句合并参数（UI 侧以秒 / 字素数输入） */
export interface MergeOptions {
  /** 短字幕阈值（秒）：结果条目时长严格小于该值算「短」 */
  shortThreshold: number;
  /** 相邻可合并最大间隔（秒）：间隙 ≤ 该值才可同组（不重叠为前提） */
  maxGap: number;
  /** 合并后最长时长（秒）：组时长 > 该值的分组合法性不成立 */
  maxDuration: number;
  /** 合并后最大字素数：连接文本字素簇数 > 该值的分组合法性不成立 */
  maxChars: number;
}

export const DEFAULT_MERGE_OPTIONS: MergeOptions = {
  shortThreshold: 1,
  maxGap: 0.3,
  maxDuration: 7,
  maxChars: 30
};

/** 参数秒值的下限与步进（毫秒精度夹取） */
export const MERGE_MIN_SECONDS = 0;
export const MERGE_MAX_SHORT_THRESHOLD = 60;
export const MERGE_MAX_GAP = 10;
export const MERGE_MAX_DURATION = 3600;
export const MERGE_MIN_CHARS = 1;
export const MERGE_MAX_CHARS = 1000;

/** 条目不参与合并的原因分类 */
export type MergeSkipKind = 'duration' | 'chars';

/** 一条原始字幕在合并预览中的裁决 */
export interface MergeEntry {
  cueId: string;
  /** 列表序号（1-based，时间序） */
  index: number;
  /** 自身时长（毫秒） */
  durationMs: number;
  /** 自身去首尾空白后的字素簇数 */
  chars: number;
  /** 与后一条的间隔（毫秒）；末条为 null */
  nextGapMs: number | null;
  /** 是否可参与某个合并组（单条原文始终保留） */
  eligible: boolean;
  /** 不可参与合并的原因（eligible 时为 null） */
  reason: string | null;
  /** 原因分类（eligible 时为 null） */
  reasonKind: MergeSkipKind | null;
}

/** 组内一条原始字幕的明细（预览折叠展示用） */
export interface MergeMember {
  cueId: string;
  /** 时间序 1-based 序号 */
  index: number;
  start: number;
  end: number;
  /** 去首尾空白后的文本 */
  text: string;
}

/** 一个结果组（单条保留或多条合并） */
export interface MergeGroup {
  /** 组内原始条目（时间序） */
  memberIds: string[];
  /** 组内条目在时间序中的 1-based 序号 */
  memberIndexes: number[];
  /** 组内各条明细（时间码 + 去空白文本） */
  members: MergeMember[];
  /** 首条起点（秒） */
  start: number;
  /** 末条终点（秒） */
  end: number;
  /** 组时长（毫秒） */
  durationMs: number;
  /** 合并后文本（去首尾空白，以单空格连接） */
  text: string;
  /** 合并后字素簇数 */
  chars: number;
  /** 是否合并了多条（false = 单条原文保留） */
  merged: boolean;
  /** 结果组是否仍短于阈值 */
  short: boolean;
}

export interface MergePlan {
  options: MergeOptions;
  /** 与时间序字幕一一对应的单条裁决 */
  entries: MergeEntry[];
  /** 全局最优分组（组按时间序，覆盖全部条目） */
  groups: MergeGroup[];
  /** 结果总条数 */
  resultCount: number;
  /** 其中仍短于阈值的条数 */
  shortCount: number;
  /** 被合并掉的条数（原条数 − 结果条数） */
  mergedAwayCount: number;
  /** 实际含多条的合并组数 */
  mergedGroupCount: number;
  /** 因超长 / 超字数而不得参与合并的条数 */
  excludedCount: number;
}

/* ---------------- 参数归一化 ---------------- */

/** 秒值参数归一化：有限、非负，四舍五入到毫秒 */
function normSeconds(v: number, max: number): number {
  if (!Number.isFinite(v)) return 0;
  const ms = Math.round(Math.max(0, Math.min(max, v)) * 1000);
  return ms / 1000;
}

/** 参数容错：时长 / 间隔夹到非负合法区间（毫秒精度），字素数夹为正整数 */
export function normalizeMergeOptions(input: MergeOptions): MergeOptions {
  return {
    shortThreshold: normSeconds(input.shortThreshold, MERGE_MAX_SHORT_THRESHOLD),
    maxGap: normSeconds(input.maxGap, MERGE_MAX_GAP),
    maxDuration: normSeconds(input.maxDuration, MERGE_MAX_DURATION),
    maxChars: Math.min(
      MERGE_MAX_CHARS,
      Math.max(MERGE_MIN_CHARS, Number.isFinite(input.maxChars) ? Math.floor(input.maxChars) : DEFAULT_MERGE_OPTIONS.maxChars)
    )
  };
}

/* ---------------- 动态规划 ---------------- */

interface ItemInfo {
  cue: Cue;
  startMs: number;
  endMs: number;
  durationMs: number;
  chars: number;
  eligible: boolean;
}

interface DpState {
  /** 该状态覆盖到的条目数 */
  at: number;
  /** 截至当前累计的短路条数 */
  shorts: number;
  /** 截至当前的组数 */
  groups: number;
  /** 前驱状态（空前缀为 null） */
  pred: DpState | null;
  /** 最后一组的起点下标 */
  lastStart: number;
  /**
   * 在同组数状态序列中的不可变字典序标签：同组数组内 label 小 =
   * 断点序列字典序靠前。标签中点耗尽时整层重编号（相对顺序不变）。
   */
  label: number;
}

/**
 * 在一段「全部可参与合并」的连续条目（infos 下标 [lo, hi)）上做分割点规划。
 * 不可参与合并的条目由调用方切段，单条原样落在两段之间。
 *
 * 单状态松弛 DP（O(n²)）：dp[j] = 覆盖前 j 条的唯一最优分割。支配关系——
 * 同一位置上，短路数更少的状态在**任意相同后缀**下都更优（短路是各组非负
 * 累加量，而后缀可行性只取决于位置，与前缀如何分组无关）；短路数相同则组数
 * 更多者恒优；仍相同取断点序列字典序最小者。
 *
 * 字典序标签：每个位置的状态在其外层迭代开始时已定案，按（前驱标签, 末断点）
 * 插入该组层的有序数组；候选比较只读前驱的当前标签，中点耗尽时整层重编号，
 * 相对顺序不变（总额外开销 O(n²)）。
 */
function planRun(infos: ItemInfo[], lo: number, hi: number, opts: MergeOptions): Array<[number, number]> {
  const n = hi - lo;
  if (n <= 1) return [[lo, hi]];

  const shortMs = Math.round(opts.shortThreshold * 1000);
  const gapMs = Math.round(opts.maxGap * 1000);
  const maxDurationMs = Math.round(opts.maxDuration * 1000);
  const maxChars = opts.maxChars;

  const dp: Array<DpState | null> = new Array(n + 1).fill(null);
  // order[g]：组数恰为 g 的已定案状态，按断点序列字典序排列
  const order: DpState[][] = new Array(n + 1);
  const root: DpState = { at: 0, shorts: 0, groups: 0, pred: null, lastStart: 0, label: 0 };
  dp[0] = root;
  order[0] = [root];

  /** （前驱标签, 本组起点, 位置）字典序比较 */
  const cmpStates = (a: DpState, b: DpState): number => {
    const pa = a.pred as DpState;
    const pb = b.pred as DpState;
    return pa.label - pb.label || a.lastStart - b.lastStart || a.at - b.at;
  };

  /** 定案状态按字典序插入所属组层，返回（可能整层重编号后的）标签 */
  const insertOrdered = (st: DpState): number => {
    const g = st.groups;
    let arr = order[g];
    if (!arr) {
      arr = [];
      order[g] = arr;
    }
    let loI = 0;
    let hiI = arr.length;
    while (loI < hiI) {
      const mid = (loI + hiI) >> 1;
      if (cmpStates(st, arr[mid]) < 0) hiI = mid;
      else loI = mid + 1;
    }
    const before = loI > 0 ? arr[loI - 1].label : null;
    const after = loI < arr.length ? arr[loI].label : null;
    let label: number;
    if (before === null) label = (after as number) - 1;
    else if (after === null) label = before + 1;
    else {
      label = (before + after) / 2;
      if (label === before || label === after) {
        // 双精度中点耗尽：整层重新等距编号（相对顺序不变，之后必有 .5 余量）
        arr.forEach((s, k) => {
          s.label = k;
        });
        label = (arr[loI - 1].label + arr[loI].label) / 2;
      }
    }
    st.label = label;
    arr.splice(loI, 0, st);
    return label;
  };

  /** 候选边 (pred)+[i,j) 松弛 dp[j] */
  const relax = (pred: DpState, i: number, j: number, isShort: boolean): void => {
    const groups = pred.groups + 1;
    const shorts = pred.shorts + (isShort ? 1 : 0);
    const cur = dp[j];
    const better =
      !cur ||
      shorts < cur.shorts ||
      (shorts === cur.shorts &&
        (groups > cur.groups ||
          (groups === cur.groups &&
            (pred.label < (cur.pred as DpState).label ||
              (pred.label === (cur.pred as DpState).label && i < cur.lastStart)))));
    if (better) {
      dp[j] = { at: j, shorts, groups, pred, lastStart: i, label: 0 };
    }
  };

  // i 外层：迭代开始时 dp[i] 已定案，先入有序序列，再扩展其全部可行组 [i, j)
  for (let i = 0; i < n; i += 1) {
    const base = dp[i];
    if (!base) continue;
    if (i > 0) insertOrdered(base);

    const first = infos[lo + i];
    let chars = 0;
    for (let j = i + 1; j <= n; j += 1) {
      const info = infos[lo + j - 1];
      if (j > i + 1) {
        const gap = info.startMs - infos[lo + j - 2].endMs;
        if (gap < 0 || gap > gapMs) break; // 之后的 j 只会跨越这个断口
      }
      chars += (j > i + 1 ? 1 : 0) + info.chars;
      const duration = info.endMs - first.startMs;
      if (duration > maxDurationMs || chars > maxChars) break; // 随 j 单调不减
      relax(base, i, j, duration < shortMs);
    }
  }

  const best = dp[n];
  if (!best) return [[hi - 1, hi]]; // 理论不可达：单条组全部合法，全单条分割必覆盖
  const out: Array<[number, number]> = [];
  let cur: DpState | null = best;
  while (cur && cur.groups > 0) {
    out.push([lo + cur.lastStart, lo + cur.at]);
    cur = cur.pred;
  }
  out.reverse();
  return out;
}

/* ---------------- 全量计划 ---------------- */

/** 连接组内文本：各条 trim 后以单个空格连接，再去整体首尾空白 */
function joinTexts(cues: Cue[], from: number, to: number): string {
  const parts: string[] = [];
  for (let i = from; i < to; i += 1) {
    const t = cues[i].text.trim();
    if (t) parts.push(t);
  }
  return parts.join(' ');
}

/**
 * 计算全部字幕的短句合并预览（时间序）。
 * 纯只读：不修改任何字幕；字幕或参数变化时由调用方重新调用。
 */
export function buildMergePlan(cues: Cue[], input: MergeOptions): MergePlan {
  const options = normalizeMergeOptions(input);
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const shortMs = Math.round(options.shortThreshold * 1000);
  const maxDurationMs = Math.round(options.maxDuration * 1000);

  const infos: ItemInfo[] = sorted.map((cue) => {
    const startMs = Math.round(cue.start * 1000);
    const endMs = Math.round(cue.end * 1000);
    const durationMs = Math.max(0, endMs - startMs);
    const chars = countGraphemes(cue.text.trim());
    return {
      cue,
      startMs,
      endMs,
      durationMs,
      chars,
      eligible: durationMs <= maxDurationMs && chars <= options.maxChars
    };
  });

  // 单条裁决（间隔仅展示用）
  const entries: MergeEntry[] = infos.map((info, i) => {
    const next = infos[i + 1] ?? null;
    let reason: string | null = null;
    let kind: MergeSkipKind | null = null;
    if (info.durationMs > maxDurationMs) {
      kind = 'duration';
      reason = `自身时长 ${(info.durationMs / 1000).toFixed(3)}s 已超过合并后最长时长 ${options.maxDuration.toFixed(
        3
      )}s，不参与合并`;
    } else if (info.chars > options.maxChars) {
      kind = 'chars';
      reason = `自身 ${info.chars} 个文字已超过合并后最大字素数 ${options.maxChars}，不参与合并`;
    }
    return {
      cueId: info.cue.id,
      index: i + 1,
      durationMs: info.durationMs,
      chars: info.chars,
      nextGapMs: next ? next.startMs - info.endMs : null,
      eligible: info.eligible,
      reason,
      reasonKind: kind
    };
  });

  // 切段：按时间序把位置划分为互斥且完整覆盖 [0, n) 的区间——
  // 可参与合并的连续条目成一个 run（交给 planRun），每个不可参与的条目
  // 各自成单条区间。两段之间不共享位置，结果天然按时间序，无需再排序。
  const ranges: Array<[number, number]> = [];
  let runStart = -1;
  const flushRun = (endExcl: number) => {
    if (runStart < 0) return;
    for (const r of planRun(infos, runStart, endExcl, options)) ranges.push(r);
    runStart = -1;
  };
  for (let i = 0; i < infos.length; i += 1) {
    if (infos[i].eligible) {
      if (runStart < 0) runStart = i;
    } else {
      flushRun(i);
      ranges.push([i, i + 1]); // 被排除的条目单条保留
    }
  }
  flushRun(infos.length);

  const groups: MergeGroup[] = ranges.map(([from, to]) => {
    const text = joinTexts(sorted, from, to);
    const start = sorted[from].start;
    const end = sorted[to - 1].end;
    const durationMs = Math.max(0, Math.round((end - start) * 1000));
    return {
      memberIds: sorted.slice(from, to).map((c) => c.id),
      memberIndexes: sorted.slice(from, to).map((_, k) => from + k + 1),
      members: sorted.slice(from, to).map((c, k) => ({
        cueId: c.id,
        index: from + k + 1,
        start: c.start,
        end: c.end,
        text: c.text.trim()
      })),
      start,
      end,
      durationMs,
      text,
      chars: countGraphemes(text),
      merged: to - from > 1,
      short: durationMs < shortMs
    };
  });

  const shortCount = groups.filter((g) => g.short).length;
  const mergedGroupCount = groups.filter((g) => g.merged).length;
  const excludedCount = entries.filter((e) => !e.eligible).length;
  return {
    options,
    entries,
    groups,
    resultCount: groups.length,
    shortCount,
    mergedAwayCount: sorted.length - groups.length,
    mergedGroupCount,
    excludedCount
  };
}

/* ---------------- 应用 ---------------- */

/**
 * 把分组计划应用为新的完整字幕数组（新数组）：
 * 每个合并组产生一条新 cue——id 取组内首条（导出按时间重排编号，id 仅内部使用），
 * 时间取首条起点 / 末条终点，文本为连接结果；其余 cue 被合并删除。
 * 没有任何多组合并（mergedAwayCount === 0）时返回 null。
 */
export function applyMerge(cues: Cue[], plan: MergePlan): Cue[] | null {
  if (plan.mergedAwayCount === 0) return null;
  const byId = new Map(cues.map((c) => [c.id, c]));
  const out: Cue[] = [];
  for (const g of plan.groups) {
    const first = byId.get(g.memberIds[0]);
    if (!first) continue;
    out.push({ id: first.id, start: g.start, end: g.end, text: g.text });
  }
  return out;
}
