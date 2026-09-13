import { getSupabaseClient, isOfflinePlayground } from './supabase.js';
import {
  DEFAULT_DEMO_SCENARIOS,
  demoScenariosFromRows,
  formatDemoScenariosForPrompt,
  type DemoScenario,
  type DemoScenarioRow,
} from './demo_scenarios.js';

export async function loadDemoScenarios(): Promise<DemoScenario[]> {
  if (isOfflinePlayground()) {
    return DEFAULT_DEMO_SCENARIOS;
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
      return DEFAULT_DEMO_SCENARIOS;
    }
    if (!data?.length) {
      return DEFAULT_DEMO_SCENARIOS;
    }
    return demoScenariosFromRows(data as DemoScenarioRow[]);
  } catch (err) {
    console.warn(
      '[demo_scenarios] fetch threw — using defaults',
      err instanceof Error ? err.message : err,
    );
    return DEFAULT_DEMO_SCENARIOS;
  }
}

export function demoPlaybookBlockFromScenarios(scenarios: DemoScenario[]): string {
  return formatDemoScenariosForPrompt(scenarios);
}
