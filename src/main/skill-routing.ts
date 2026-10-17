import path from 'node:path';
import { routeSkillMetadata, type RoutedSkillSelection } from '../shared/skill-routing.js';
import { managedSkillRoutingMetadata, type SkillLibraryScope } from './skill-library.js';

const ETD_PROJECT = 'etd-sports-market-engine';
const ETD_ROUTER = 'etd-external-skill-router';

function etdPreflight(scope: SkillLibraryScope, candidates: Awaited<ReturnType<typeof managedSkillRoutingMetadata>>): RoutedSkillSelection[] | null {
  if (!scope.projectPath || path.basename(path.resolve(scope.projectPath)).toLowerCase() !== ETD_PROJECT) return null;
  const router = candidates.find(candidate => candidate.id === ETD_ROUTER && candidate.allowImplicitInvocation);
  return router ? [{ id: router.id, revision: router.revision }] : [];
}

/** Automatic first slice: route only managed/imported Skills whose metadata is already cached. */
export async function autoSelectManagedSkills(authored: string, scope: SkillLibraryScope = {}): Promise<RoutedSkillSelection[]> {
  const candidates = await managedSkillRoutingMetadata(scope);
  return etdPreflight(scope, candidates) ?? routeSkillMetadata(authored, candidates);
}
