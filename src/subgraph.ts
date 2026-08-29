export class SubgraphError extends Error {}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

// Plain fetch + a query string, no client library — the subgraph is a single GraphQL
// endpoint with no auth, so a client library would only add a dependency for what's a
// one-shot POST here.
export async function querySubgraph<T>(
  url: string,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new SubgraphError(
      `Subgraph request to ${url} failed: ${(err as Error).message}. The subgraph may be unreachable or timing out.`
    );
  }

  if (!response.ok) {
    throw new SubgraphError(`Subgraph request to ${url} returned HTTP ${response.status}.`);
  }

  let body: GraphQLResponse<T>;
  try {
    body = (await response.json()) as GraphQLResponse<T>;
  } catch {
    throw new SubgraphError(`Subgraph response from ${url} was not valid JSON.`);
  }

  if (body.errors && body.errors.length > 0) {
    throw new SubgraphError(`Subgraph query to ${url} returned errors: ${body.errors.map((e) => e.message).join("; ")}`);
  }

  if (!body.data) {
    throw new SubgraphError(`Subgraph response from ${url} had no data.`);
  }

  return body.data;
}
