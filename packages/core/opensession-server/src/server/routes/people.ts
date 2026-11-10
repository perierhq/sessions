/**
 * Team directory endpoint — the roster the frontend uses for people pickers,
 * avatars and @-mention completion (see src/server/people.ts).
 */

import type { RouteContext } from "./context";

export async function handlePeopleRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;

  if (path === "/api/people" && req.method === "GET") {
    const { botDirectory, reviewTeamDirectory, teamDirectory } =
      await import("../../server/people");
    return Response.json({
      people: teamDirectory(),
      // Apart from `people`, so no picker offers a bot.
      bots: botDirectory(),
      reviewTeams: reviewTeamDirectory(),
    });
  }

  return undefined;
}
