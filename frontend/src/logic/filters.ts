import type { ConversationStar, StarFilterState } from '../types/sky';
import { getEffectiveRequests, starHasActivityOnDate } from './metrics';
import type { StarNode } from './starLayout';

/**
 * Format conversation title while masking sensitive names in privacy mode.
 */
export function getDisplayTitle(
  star: ConversationStar,
  index: number,
  privacyMode: boolean,
): string {
  if (!privacyMode) {
    return star.title;
  }
  const oneBased = Math.max(1, index + 1);
  return `星体 #${String(oneBased).padStart(3, '0')}`;
}

/**
 * Filter conversations by model, celestial type, optional request-activity date,
 * and keyword. In privacy mode, keyword matching excludes titles to prevent leaks.
 */
export function filterConversations(
  stars: ConversationStar[],
  filter: StarFilterState,
  privacyMode: boolean,
): ConversationStar[] {
  const query = filter.query.trim().toLowerCase();
  const dateFilter = filter.date?.trim() ?? '';
  const hasModels = filter.models.length > 0;
  const hasTypes = filter.celestialTypes.length > 0;

  return stars.filter((star) => {
    if (hasModels) {
      const matchesModel =
        filter.models.includes(star.primary_model) ||
        star.models.some((m) => filter.models.includes(m.model));
      if (!matchesModel) {
        return false;
      }
    }

    if (hasTypes && !filter.celestialTypes.includes(star.celestial_type)) {
      return false;
    }

    if (dateFilter && !starHasActivityOnDate(star, dateFilter)) {
      return false;
    }

    if (query) {
      const modelMatch =
        star.primary_model.toLowerCase().includes(query) ||
        star.models.some((m) => m.model.toLowerCase().includes(query));
      const reqs = getEffectiveRequests(star);
      const dateMatch =
        star.local_date.toLowerCase().includes(query) ||
        reqs.some((r) => (r.local_date || star.local_date).toLowerCase().includes(query));
      if (privacyMode) {
        return modelMatch || dateMatch;
      }
      const titleMatch = star.title.toLowerCase().includes(query);
      return titleMatch || modelMatch || dateMatch;
    }

    return true;
  });
}

/**
 * Filter request-level star nodes by request model, celestial type, actual local date,
 * and keyword. In privacy mode, keyword matching excludes conversation titles.
 */
export function filterStarNodes(
  nodes: StarNode[],
  filter: StarFilterState,
  privacyMode: boolean,
): StarNode[] {
  const query = filter.query.trim().toLowerCase();
  const dateFilter = filter.date?.trim() ?? '';
  const hasModels = filter.models.length > 0;
  const hasTypes = filter.celestialTypes.length > 0;

  return nodes.filter((node) => {
    const { request, star } = node;
    const reqDate = request.local_date || star.local_date;

    if (hasModels && !filter.models.includes(request.model)) {
      return false;
    }

    if (hasTypes && !filter.celestialTypes.includes(request.celestial_type)) {
      return false;
    }

    if (dateFilter && reqDate !== dateFilter) {
      return false;
    }

    if (query) {
      const modelMatch = request.model.toLowerCase().includes(query);
      const dateMatch = reqDate.toLowerCase().includes(query);
      const roleMatch = request.subagent_role.toLowerCase().includes(query);
      if (privacyMode) {
        return modelMatch || dateMatch || roleMatch;
      }
      const titleMatch = star.title.toLowerCase().includes(query);
      return titleMatch || modelMatch || dateMatch || roleMatch;
    }

    return true;
  });
}
