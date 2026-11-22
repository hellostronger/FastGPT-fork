/**
 * Skill 入口扫描规则模块。
 *
 * 上游 #7804 在 PR 内部重构后把扫描规则合并进了 `skill/utils.ts`（commit message
 * 中提到的独立文件 `skillEntryScan.ts` 已被合并掉）。1.6.x 保留这个模块入口，
 * 只做 re-export，扫描实现仍然只有 `utils.ts` 一份，避免发布校验、版本元数据解析
 * 与运行态扫描口径漂移。
 */
export {
  RUNTIME_SKILL_SCAN_PRUNE_DIRS,
  findSkillMdEntries,
  type SkillScanEntry
} from '../utils';
