import { getSupabaseClient, isOfflinePlayground } from './supabase.js';
import {
  DEFAULT_DEMO_SCENARIOS,
  demoScenariosFromRows,
  formatDemoScenariosForPrompt,
  type DemoScenario,
  type DemoScenarioRow,
} from './demo_scenarios.js';

/** Demo line — salon playbook removed (unprompted salon talk confused callers). */
const DEMO_SCENARIO_EXCLUDE = new Set(['salon']);

function filterDemoScenarios(scenarios: DemoScenario[]): DemoScenario[] {
  return scenarios.filter((s) => !DEMO_SCENARIO_EXCLUDE.has(s.slug));
}

export async function loadDemoScenarios(): Promise<DemoScenario[]> {
  if (isOfflinePlayground()) {
    return filterDemoScenarios(DEFAULT_DEMO_SCENARIOS);
  }
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('demo_scenarios')
      .select('slug, label, trigger_keywords, beats, is_active, sort_order')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error) {
      console.warn('[demo_scenarios] fetch failed — using defaults', error.message);
      return filterDemoScenarios(DEFAULT_DEMO_SCENARIOS);
    }
    if (!data?.length) {
      return filterDemoScenarios(DEFAULT_DEMO_SCENARIOS);
    }
    return filterDemoScenarios(demoScenariosFromRows(data as DemoScenarioRow[]));
  } catch (err) {
    console.warn(
      '[demo_scenarios] fetch threw — using defaults',
      err instanceof Error ? err.message : err,
    );
    return filterDemoScenarios(DEFAULT_DEMO_SCENARIOS);
  }
}

export function demoPlaybookBlockFromScenarios(scenarios: DemoScenario[]): string {
  return formatDemoScenariosForPrompt(scenarios);
}
