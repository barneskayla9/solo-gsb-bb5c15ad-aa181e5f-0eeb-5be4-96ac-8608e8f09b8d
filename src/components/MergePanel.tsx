import { secondsToSrtTime } from '../lib/srt';
import {
  DEFAULT_MERGE_OPTIONS,
  MERGE_DURATION_MAX,
  MERGE_DURATION_MIN,
  MERGE_GAP_MAX,
  MERGE_GAP_MIN,
  MERGE_GRAPHEMES_MAX,
  MERGE_GRAPHEMES_MIN,
  MERGE_SHORT_MAX,
  MERGE_SHORT_MIN,
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
  /** 一次应用全部合并组 */
  onApply: () => void;
  /** 点击条目定位字幕（列表 / 时间轴，定位到组首条） */
  onLocate: (cueId: string) => void;
}

/** 数字参数输入：受控、越界时由 App 夹取 */
function NumberField(props: {
  label: string;
  title: string;
  value: number;
  step: number;
  min: number;
  max: number;
  suffix: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="merge-param" title={props.title}>
      {props.label}
      <input
        type="number"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) props.onChange(v);
        }}
      />
      <span className="merge-param-unit">{props.suffix}</span>
    </label>
  );
}

/**
 * 短句合并面板（与断行排版共用侧栏，页签切换）：
 * 设置短字幕阈值、相邻可合并最大间隔、合并后最长时长与最大字素数，
 * 立即预览全局最优分组的合并后时间码与文本。只合并不重叠且间隔不超限的
 * 相邻条目；超出时长 / 字数限制的条目保留单条并说明原因（见 lib/merge）。
 * 选点为全局最优：先最少短句结果 → 再最少被合并条数 → 同分取更早断点。
 * 没有可合并分组时应用按钮禁用；字幕或参数变化时由 App 立即重算。
 */
export default function MergePanel(p: MergePanelProps) {
  const plan = p.plan;
  const options = p.options;

  const set = (patch: Partial<MergeOptions>) => p.onOptionsChange({ ...options, ...patch });

  return (
    <aside className="reflow-panel merge-panel">
      <div className="reflow-head">
        短句合并
        <span className="hint" title="把被切成数条的相邻短句合并为一条，取首条起点与末条终点">
          相邻短句合并
        </span>
      </div>

      <div className="reflow-params merge-params">
        <NumberField
          label="短字幕阈值"
          title="结果条目时长短于该值即算短句；分组时先最小化这种结果条数"
          value={options.shortThresholdSec}
          step={0.1}
          min={MERGE_SHORT_MIN}
          max={MERGE_SHORT_MAX}
          suffix="s"
          onChange={(v) => set({ shortThresholdSec: v })}
        />
        <NumberField
          label="最大间隔"
          title="相邻两条间隔不超过该值（且不重叠）才允许合并"
          value={options.maxGapSec}
          step={0.05}
          min={MERGE_GAP_MIN}
          max={MERGE_GAP_MAX}
          suffix="s"
          onChange={(v) => set({ maxGapSec: v })}
        />
        <NumberField
          label="最长时长"
          title="合并后时长超过该值的分组不可行；单条已超时也不参与合并"
          value={options.maxDurationSec}
          step={0.5}
          min={MERGE_DURATION_MIN}
          max={MERGE_DURATION_MAX}
          suffix="s"
          onChange={(v) => set({ maxDurationSec: v })}
        />
        <NumberField
          label="最大字素数"
          title="合并后文本的 Unicode 字素簇数（含连接空格）超过该值不可行；单条已超也不参与合并"
          value={options.maxGraphemes}
          step={1}
          min={MERGE_GRAPHEMES_MIN}
          max={MERGE_GRAPHEMES_MAX}
          suffix="字"
          onChange={(v) => set({ maxGraphemes: v })}
        />
        <button
          type="button"
          className="btn mini merge-reset"
          title="恢复默认参数（1s / 0.3s / 7s / 42 字）"
          onClick={() => p.onOptionsChange({ ...DEFAULT_MERGE_OPTIONS })}
        >
          默认
        </button>
      </div>

      <div className="reflow-summary">
        {p.cueCount === 0
          ? '尚未导入 SRT 文件'
          : plan
            ? `原 ${plan.sourceCount} 条 → 结果 ${plan.resultCount} 条 · 合并组 ${plan.mergedGroupCount} 组（消去 ${plan.mergedAway} 条）· 仍短 ${plan.remainingShort} 条 · 超限不参与 ${plan.excludedCount} 条`
            : ''}
      </div>

      <div className="reflow-body">
        {p.cueCount === 0 && <div className="empty">导入 SRT 后，这里预览连续条目按当前参数分组后的时间码与文本</div>}
        {plan?.tooLarge && (
          <div className="merge-too-large">
            字幕条数超过 {plan.sourceCount} 条的分组求解上限，已禁用自动合并预览（全部按单条保留）；可拆分文件后重试。
          </div>
        )}
        {plan?.groups.map((g, gi) => {
          const firstIdx = g.members[0].index;
          const lastIdx = g.members[g.members.length - 1].index;
          const rowClass = [
            'reflow-row',
            'merge-row',
            g.merged ? 'merged' : 'single',
            g.short ? 'short' : null,
            g.retainReason ? 'retain' : null
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <div key={`g-${gi}-${firstIdx}`} className={rowClass} onClick={() => p.onLocate(g.members[0].cueId)} title="点击定位到该组首条字幕">
              <div className="reflow-row-top">
                <span className="reflow-idx">
                  {g.merged ? `#${firstIdx}–${lastIdx}` : `#${firstIdx}`}
                </span>
                {g.merged ? (
                  <span className="reflow-badge ok">{g.members.length} 合 1 · 消去 {g.members.length - 1} 条</span>
                ) : (
                  <span className="reflow-badge skip">单条保留</span>
                )}
                {g.short && <span className="merge-badge short" title="结果时长仍短于短字幕阈值">仍短</span>}
                <span className="merge-dur" title="合并后时长 / 字素簇数">
                  {(g.durationMs / 1000).toFixed(3)}s · {g.chars} 字
                </span>
              </div>

              <div className="merge-time">
                {secondsToSrtTime(g.start)} → {secondsToSrtTime(g.end)}
              </div>

              {g.merged && (
                <div className="merge-members">
                  {g.members.map((m) => (
                    <div key={m.cueId} className="merge-member" title={`#${m.index} 原条目 · ${(m.durationMs / 1000).toFixed(3)}s · ${m.chars} 字`}>
                      <span className="merge-member-time">
                        {secondsToSrtTime(m.start)} → {secondsToSrtTime(m.end)}
                      </span>
                      <span className="merge-member-text">{m.trimmed || <span className="reflow-blank">（空文本）</span>}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="reflow-pair">
                <div className="reflow-text new" title="合并后文本（应用后写入字幕）">
                  {g.text || <span className="reflow-blank">（空文本）</span>}
                </div>
              </div>

              {g.retainReason && <div className="reflow-reason">⛔ {g.retainReason}</div>}
            </div>
          );
        })}
      </div>

      <div className="reflow-foot">
        <button
          className="btn primary mini"
          disabled={!plan || plan.mergedAway === 0}
          onClick={p.onApply}
          title={
            plan && plan.mergedAway > 0
              ? `按预览把 ${plan.mergedGroupCount} 个分组合并（消去 ${plan.mergedAway} 条），作为一次历史操作，可撤销/重做`
              : '当前参数下没有可合并的连续条目分组'
          }
        >
          应用全部合并{plan && plan.mergedAway > 0 ? `（消去 ${plan.mergedAway} 条）` : ''}
        </button>
        <span className="reflow-foot-hint">
          合并为一次历史操作可撤销/重做 · 现有 SRT 导出反映结果
        </span>
      </div>
    </aside>
  );
}
