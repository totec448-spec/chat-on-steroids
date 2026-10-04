import { routeSkillMetadata, type RoutedSkillSelection } from '../shared/skill-routing.js';
import { managedSkillRoutingMetadata, type SkillLibraryScope } from './skill-library.js';

/** Automatic first slice: route only managed/imported Skills whose metadata is already cached. */
export async function autoSelectManagedSkills(authored: string, scope: SkillLibraryScope = {}): Promise<RoutedSkillSelection[]> {
  return routeSkillMetadata(authored, await managedSkillRoutingMetadata(scope));
}
