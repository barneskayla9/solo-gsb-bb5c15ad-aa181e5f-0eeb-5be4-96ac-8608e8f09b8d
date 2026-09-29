import { useState } from 'react';
import { secondsToSrtTime } from '../lib/srt';
import {
  MERGE_MAX_CHARS,
  MERGE_MAX_DURATION,
  MERGE_MAX_GAP,
  MERGE_MAX_SHORT_THRESHOLD,
  type MergeOptions,
  type MergePlan
} from '../lib/merge';

interface MergePanelProps {
  /** 当前字幕条数（0 时仅提示导入） */
  cueCount: number;
  /** 当前参数（已夹取合法范围） */
  options: MergeOptions;
  onOptionsChange: (next: MergeOptions) => void;
  /** 全局分组预览；无字幕时为 null */
  plan: MergePlan | null;
  /** 一次应用全部合并分组 */
  onApply: () => void;
  /** 点击结果组定位到首条字幕（列表 / 时间轴） */
  onLocate: (cueId: string) => void;
}

/** 毫秒 -> SRT 时间码（00:00:00,000） */
function msToSrt(ms: number): string {
  return secondsToSrtTime(ms / 1000);
}

/** 秒参数输入：空串 / 非数字回退到当前值，夹取交由 App 的归一化统一处理 */
function parseSeconds(raw: string, fallback: number): number {
  const v = Number(raw);
  return raw.trim() !== '' && Number.isFinite(v) ? v : fallback;
}

/**
 * 短句合并面板（停靠在字幕列表旁）：
 * 设置短字幕阈值、相邻可合并最大间隔、合并后最长时长与最大字素数，
 * 立即预览全局最优分组的连续条目范围、合并后时间码与文本。
 * 只合并时间不重叠且间隔不超限的相邻条目；组取首条起点 / 末条终点，
 * 文本去首尾空白后以单个空格连接，字数按 Unicode 字素簇计。
 * 全局先最小化短于阈值的结果条数，再最小化被合并掉的条数，同分取更早断点；
 * 自身超时长 / 超字数的条目不得参与合并并说明原因。
 * 字幕或参数变化时由 App 立即重算预览；没有可改分组时禁用应用。
 */
export default function MergePanel(p: MergePanelProps) {
  const plan = p.plan;
  const options = p.options;
  const [openKey, setOpenKey] = useState<string | null>(null);

  return (
    <aside className="merge-panel">
      <div className="merge-head">
        短句合并
        <span
          className="hint"
          title="把被切成数条的相邻短句合并为一条；时间取首起点 / 末终点，文本去空白后以空格连接"
        >
          相邻条目分组
        </span>
      </div>

      <div className="merge-params">
        <label
          className="merge-param"
          title="短字幕阈值（秒）：结果条目时长严格短于该值算「短句」；全局分组先最小化这种结果条数"
        >
          短字幕阈值
          <input
            type="number"
            min={0}
            max={MERGE_MAX_SHORT_THRESHOLD}
            step={0.1}
            value={options.shortThreshold}
            onChange={(e) =>
              p.onOptionsChange({ ...options, shortThreshold: parseSeconds(e.target.value, options.shortThreshold) })
            }
          />
          s
        </label>
        <label
          className="merge-param"
          title="相邻可合并最大间隔（秒）：只合并不重叠且间隙不超过该值的相邻条目（恰好等于可合并）"
        >
          最大间隔
          <input
            type="number"
            min={0}
            max={MERGE_MAX_GAP}
            step={0.05}
            value={options.maxGap}
            onChange={(e) => p.onOptionsChange({ ...options, maxGap: parseSeconds(e.target.value, options.maxGap) })}
          />
          s
        </label>
        <label
          className="merge-param"
          title="合并后最长时长（秒）：合并组时长超过该值不成立；自身时长已超限的条目不参与任何合并"
        >
          合并最长时长
          <input
            type="number"
            min={0}
            max={MERGE_MAX_DURATION}
            step={0.5}
            value={options.maxDuration}
            onChange={(e) =>
              p.onOptionsChange({ ...options, maxDuration: parseSeconds(e.target.value, options.maxDuration) })
            }
          />
          s
        </label>
        <label
          className="merge-param"
          title="合并后最大字素数（按 Unicode 字素簇计数，emoji / 组合字符各算 1 个）；自身字数已超限的条目不参与任何合并"
        >
          最大字素数
          <input
            type="number"
            min={1}
            max={MERGE_MAX_CHARS}
            step={1}
            value={options.maxChars}
            onChange={(e) => {
              const v = Math.floor(Number(e.target.value));
              p.onOptionsChange({
                ...options,
                maxChars: e.target.value.trim() !== '' && Number.isFinite(v) ? v : options.maxChars
              });
            }}
          />
          字
        </label>
      </div>

      <div className="merge-summary">
        {p.cueCount === 0
          ? '尚未导入 SRT 文件'
          : plan
            ? `共 ${p.cueCount} 条 → 合并后 ${plan.resultCount} 条 · 仍短句 ${plan.shortCount} 条 · 合并掉 ${plan.mergedAwayCount} 条 · 禁合并 ${plan.excludedCount} 条`
            : ''}
      </div>

      <div className="merge-body">
        {p.cueCount === 0 && (
          <div className="empty">导入 SRT 后，这里预览连续短句按当前参数分组合并后的时间码与文本</div>
        )}
        {plan?.groups.map((g) => {
          const firstEntry = plan.entries[g.memberIndexes[0] - 1];
          const excluded = !g.merged && !!firstEntry && !firstEntry.eligible;
          const key = g.memberIds[0];
          const open = openKey === key;
          return (
            <div
              key={key}
              className={['merge-row', g.merged ? 'merged' : 'single', g.short ? 'short' : '', excluded ? 'excluded' : '']
                .filter(Boolean)
                .join(' ')}
              onClick={() => p.onLocate(key)}
              title="点击定位到该组首条字幕"
            >
              <div className="merge-row-top">
                <span className="merge-idx">
                  {g.memberIndexes.length > 1
                    ? `#${g.memberIndexes[0]}–${g.memberIndexes[g.memberIndexes.length - 1]}`
                    : `#${g.memberIndexes[0]}`}
                </span>
                {g.merged ? (
                  <span className="merge-badge merged">合并 {g.memberIndexes.length} 条</span>
                ) : excluded ? (
                  <span className="merge-badge excluded" title={firstEntry?.reason ?? ''}>
                    禁合并
                  </span>
                ) : (
                  <span className="merge-badge single">单条保留</span>
                )}
                {g.short && <span className="merge-badge short">仍短句</span>}
                <span className="merge-meta">
                  {(g.durationMs / 1000).toFixed(3)}s · {g.chars} 字
                </span>
                {g.merged && (
                  <button
                    type="button"
                    className="merge-expand"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenKey(open ? null : key);
                    }}
                    title={open ? '收起组内各条明细' : '展开组内各条原时间码与文本'}
                  >
                    {open ? '▾' : '▸'}
                  </button>
                )}
              </div>
              <div className="merge-time" title="合并后时间码：首条起点 → 末条终点">
                {msToSrt(Math.round(g.start * 1000))} → {msToSrt(Math.round(g.end * 1000))}
              </div>
              <div className="merge-text" title="合并后文本（各条去首尾空白后以单个空格连接）">
                {g.text === '' ? <span className="merge-blank">（空文本）</span> : g.text}
              </div>
              {excluded && <div className="merge-reason">⛔ {firstEntry?.reason}</div>}
              {open && g.merged && (
                <div className="merge-members" onClick={(e) => e.stopPropagation()}>
                  {g.members.map((m) => (
                    <div key={m.cueId} className="merge-member">
                      <span className="merge-member-idx">#{m.index}</span>
                      <span className="merge-member-time">
                        {msToSrt(Math.round(m.start * 1000))} → {msToSrt(Math.round(m.end * 1000))}
                      </span>
                      <span className="merge-member-text">{m.text === '' ? '（空文本）' : m.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="merge-foot">
        <button
          className="btn primary mini"
          disabled={!plan || plan.mergedAwayCount === 0}
          onClick={p.onApply}
          title={
            plan && plan.mergedAwayCount > 0
              ? `把 ${plan.mergedGroupCount} 个分组合并（消去 ${plan.mergedAwayCount} 条），作为一次历史操作，可撤销/重做`
              : '当前参数下没有可合并的连续条目分组'
          }
        >
          应用全部合并{plan && plan.mergedAwayCount > 0 ? `（${plan.mergedAwayCount}）` : ''}
        </button>
        <span className="merge-foot-hint">
          首起点 / 末终点 · 空格连接 · 一次历史操作可撤销/重做 · 现有 SRT 导出反映结果
        </span>
      </div>
    </aside>
  );
}
