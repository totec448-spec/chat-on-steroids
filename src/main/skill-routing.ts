import { routeSkillMetadata, type RoutedSkillSelection } from '../shared/skill-routing.js';
import { managedSkillRoutingMetadata, type SkillLibraryScope } from './skill-library.js';
import { logInfo } from './logger.js';

/** Automatic first slice: route only managed/imported Skills whose metadata is already cached. */
export async function autoSelectManagedSkills(authored: string, scope: SkillLibraryScope = {}): Promise<RoutedSkillSelection[]> {
  const selected = routeSkillMetadata(authored, await managedSkillRoutingMetadata(scope));
  logInfo(selected.length
    ? 'skills: automatic selection chose one eligible literal name'
    : 'skills: automatic selection skipped: no single eligible non-excluded literal name');
  return selected;
}
