import {
  KNOWLEDGE_SWITCH,
  KNOWLEDGE_SWITCH_HINT,
  KNOWLEDGE_SWITCH_LABEL,
  KNOWLEDGE_SWITCH_TEXT,
} from "../../../lib/project-settings-classes";
import { knowledgeHint } from "../../../lib/project-settings/page-model";
import { Switch } from "../../../ui/switch";

/**
 * A Support website's "Use as knowledge" switch, under its row in the
 * access table (desktop) and the Support role's list (phone). Off, the site
 * is one replies may link to; on, the knowledge import reads its pages and
 * replies may rely on them. The whole label is the target.
 */
export function WebsiteKnowledgeSwitch({
  host,
  on,
  onChange,
}: {
  host: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className={KNOWLEDGE_SWITCH}>
      <Switch
        size="sm"
        checked={on}
        aria-label={`Use ${host} as knowledge`}
        onCheckedChange={(checked) => onChange(checked)}
      />
      <span className={KNOWLEDGE_SWITCH_TEXT}>
        <span className={KNOWLEDGE_SWITCH_LABEL}>Use as knowledge</span>
        <span className={KNOWLEDGE_SWITCH_HINT}>{knowledgeHint(host)}</span>
      </span>
    </label>
  );
}
