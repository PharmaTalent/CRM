import {
  createClient, SearchPerson, CompanyRecord,
  RAPIDAPI_KEY, RAPIDAPI_HOST, _diag, KEYWORD_EXPANSION, LEADERSHIP_PAGE_PATTERNS,
  normalizeCompanyName, delay, extractLinkedInUsername
} from "./types.ts";

// ============================================================================
// STAGE 0: SETUP - COMPANY LOOKUP
// ============================================================================

export async function setupCompanyAndTA(
  supabase: ReturnType<typeof createClient>,
  companyName: string,
  ta_id: string
): Promise<{
  company: CompanyRecord;
  isNMFocused: boolean;
}> {
  console.log(`[STAGE 0] Looking up company: ${companyName}`);

  const { data: company, error } = await supabase
    .from("companies")
    .select("company_id, company_name, website, nm_commitment_level, company_type, key_therapeutic_focus")
    .ilike("company_name", `%${companyName}%`)
    .limit(1)
    .single();

  if (error || !company) {
    throw new Error(`Company not found: ${companyName}. Error: ${error?.message}`);
  }

  console.log(`[STAGE 0] Found company: ${company.company_name} (id: ${company.company_id})`);

  const ktf = company.key_therapeutic_focus;
  const ktfStr = typeof ktf === "string" ? ktf : JSON.stringify(ktf || "");
  const isNMFocused = Boolean(
    (company.nm_commitment_level &&
      ["heavy", "moderate"].includes(company.nm_commitment_level.toLowerCase())) ||
    (ktfStr && ktfStr.toLowerCase().includes("neuromuscular"))
  );

  console.log(`[STAGE 0] NM-focused company: ${isNMFocused}, type: ${company.company_type}`);

  return { company: company as CompanyRecord, isNMFocused };
}

// ============================================================================
// STAGE 1: SEARCH PEOPLE - MULTI-ROUND STRATEGY (v19: PARALLELIZED)
// ============================================================================

export async function searchPeopleRound(
  normalizedName: string,
  keywordTitle: string,
  roundName: string,
  start: number = 0
): Promise<{ people: SearchPerson[]; total: number }> {
  const url = new URL(
    `https://${RAPIDAPI_HOST}/search-people`
  );
  url.searchParams.set("company", normalizedName);
  if (keywordTitle) {
    url.searchParams.set("keywordTitle", keywordTitle);
  }
  url.searchParams.set("start", start.toString());

  console.log(
    `[STAGE 1] Searching: round=${roundName}, keyword="${keywordTitle}", start=${start}`
  );

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": RAPIDAPI_HOST,
      },
    });

    if (!response.ok) {
      console.warn(
        `[STAGE 1] RapidAPI returned ${response.status} for round ${roundName}`
      );
      _diag.rounds.push({ round: roundName, url: url.toString(), status: response.status, rawItemCount: 0, parsedCount: 0 });
      _diag.errors.push(`Round ${roundName}: HTTP ${response.status}`);
      return { people: [], total: 0 };
    }

    const data = await response.json();

    // Capture first raw response for diagnostics
    if (!_diag.firstRawResponse) {
      const topKeys = Object.keys(data || {});
      const dataKeys = data?.data ? Object.keys(data.data) : [];
      const firstItem = data?.data?.items?.[0] || data?.items?.[0] || data?.data?.data?.items?.[0] || null;
      _diag.firstRawResponse = {
        topKeys,
        dataKeys,
        totalItems: data?.data?.items?.length ?? data?.items?.length ?? data?.data?.data?.items?.length ?? "none",
        firstItemKeys: firstItem ? Object.keys(firstItem) : [],
        firstItemSample: firstItem ? { fullName: firstItem.fullName, full_name: firstItem.full_name, profileURL: firstItem.profileURL, profile_url: firstItem.profile_url, linkedin_url: firstItem.linkedin_url, headline: firstItem.headline, title: firstItem.title, position: firstItem.position } : null,
      };
    }

    const items = data?.data?.items || data?.items || data?.data?.data?.items || [];
    const total = data?.data?.total ?? data?.total ?? items.length;

    const sampleKeys = items.length > 0 ? Object.keys(items[0]).slice(0, 15) : [];

    const parsed = items
      .filter(
        (item: Record<string, string>) =>
          item.fullName && item.profileURL
      )
      .map(
        (item: Record<string, string>) =>
          ({
            fullName: item.fullName,
            headline: item.headline || "",
            profileURL: item.profileURL,
            profilePicture: item.profilePicture,
            location: item.location,
            summary: item.summary,
            searchRound: roundName,
            scoringBoost: 0,
          } as SearchPerson)
      );

    _diag.rounds.push({ round: roundName, url: url.toString(), status: 200, rawItemCount: items.length, parsedCount: parsed.length, sampleKeys });

    return { people: parsed, total };
  } catch (error) {
    console.error(`[STAGE 1] Error in round ${roundName}:`, error);
    _diag.errors.push(`Round ${roundName}: ${(error as Error).message}`);
    return { people: [], total: 0 };
  }
}

// Helper: search with auto-pagination (fetches page 2 if total > 10)
async function searchWithPagination(
  normalizedName: string,
  keywordTitle: string,
  roundName: string
): Promise<SearchPerson[]> {
  const { people: page1, total } = await searchPeopleRound(normalizedName, keywordTitle, roundName, 0);

  // If there are more results beyond the first page, fetch page 2
  if (total > 10) {
    console.log(`[STAGE 1] ${roundName}: total=${total}, fetching page 2...`);
    await delay(50);
    const { people: page2 } = await searchPeopleRound(normalizedName, keywordTitle, `${roundName}_p2`, 10);
    return [...page1, ...page2];
  }

  return page1;
}

export function expandKeywords(keywords: string | undefined): string[] {
  if (!keywords || keywords.trim() === "") return [];

  const expanded = new Set<string>();
  const parts = keywords.split(",").map((k) => k.trim()).filter(k => k.length > 0);

  for (const keyword of parts) {
    const upper = keyword.toUpperCase();
    expanded.add(keyword);
    if (KEYWORD_EXPANSION[upper]) {
      KEYWORD_EXPANSION[upper].forEach((e) => expanded.add(e));
    }
  }

  return Array.from(expanded);
}

// ============================================================================
// LEADERSHIP PAGE SCRAPING (v19: parallelized LinkedIn lookups)
// ============================================================================

export async function searchLeadershipPage(
  companyRecord: CompanyRecord,
  normalizedName: string
): Promise<SearchPerson[]> {
  console.log("[STAGE 1] Attempting leadership page scraping...");

  let baseUrl = companyRecord.website || "";
  if (baseUrl && !baseUrl.startsWith("http")) baseUrl = "https://" + baseUrl;
  baseUrl = baseUrl.replace(/\/$/, "");
  const people: SearchPerson[] = [];
  const tried = new Set<string>();
  let leadershipHtml = "";
  let foundLeadershipUrl = "";

  // If no website in DB, try RapidAPI company search first, then DuckDuckGo
  if (!baseUrl) {
    console.log("[STAGE 1] No website in DB, trying RapidAPI company search...");
    try {
      const resp = await fetch(
        `https://${RAPIDAPI_HOST}/search-company?query=${encodeURIComponent(normalizedName)}`,
        { headers: { "x-rapidapi-key": RAPIDAPI_KEY, "x-rapidapi-host": RAPIDAPI_HOST } }
      );
      const data = await resp.json();
      const found = data?.data?.items?.[0] || data?.data?.[0];
      baseUrl = found?.websiteUrl || found?.website || "";
      if (baseUrl) console.log(`[STAGE 1] Found website via RapidAPI: ${baseUrl}`);
    } catch (e) { console.log("[STAGE 1] RapidAPI company search failed"); }
  }

  if (!baseUrl) {
    console.log("[STAGE 1] Trying DuckDuckGo web search for company website...");
    const searchQueries = [
      `${normalizedName} leadership team`,
      `${normalizedName} executive team`,
      `${normalizedName} company website`,
    ];
    for (const query of searchQueries) {
      try {
        const resp = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
          method: "GET",
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "text/html",
          },
        });
        if (!resp.ok) continue;
        const html = await resp.text();
        const urlMatches = html.match(/href="(https?:\/\/[^"]+)"/gi) || [];

        for (const match of urlMatches) {
          const url = match.match(/href="(https?:\/\/[^"]+)"/i)?.[1] || "";
          if (/duckduckgo|google|bing|wikipedia|linkedin|facebook|twitter|glassdoor|indeed|youtube/i.test(url)) continue;

          const urlLower = url.toLowerCase();
          if (/leader|team|management|executive|people|about/i.test(urlLower)) {
            console.log(`[STAGE 1] Web search found leadership page: ${url}`);
            try {
              const pageResp = await fetch(url, {
                redirect: "follow",
                headers: { "User-Agent": "Mozilla/5.0 (compatible; PharmaTalent/1.0)", "Accept": "text/html" },
                signal: AbortSignal.timeout(8000),
              });
              if (pageResp.ok) {
                const pageHtml = await pageResp.text();
                if (pageHtml.length > 1000) {
                  try {
                    const parsed = new URL(url);
                    baseUrl = `${parsed.protocol}//${parsed.hostname}`;
                  } catch (_) {}
                  leadershipHtml = pageHtml;
                  foundLeadershipUrl = url;
                  break;
                }
              }
            } catch (_) {}
          }

          if (!baseUrl) {
            try {
              const parsed = new URL(url);
              baseUrl = `${parsed.protocol}//${parsed.hostname}`;
              console.log(`[STAGE 1] Web search found company site: ${baseUrl}`);
            } catch (_) {}
          }
        }
        if (baseUrl || leadershipHtml) break;
        await delay(500);
      } catch (e) {
        console.log(`[STAGE 1] Web search failed for "${query}"`);
      }
    }
  }

  if (!baseUrl && !leadershipHtml) {
    console.log("[STAGE 1] No website found, skipping leadership page scraping");
    return [];
  }

  // Try path-based search only if we don't already have leadership HTML
  if (!leadershipHtml && baseUrl) {
    for (const pattern of LEADERSHIP_PAGE_PATTERNS) {
      const tryUrl = `${baseUrl.replace(/\/$/, "")}${pattern}`;
      if (tried.has(tryUrl)) continue;
      tried.add(tryUrl);

      try {
        console.log(`[STAGE 1] Trying leadership URL: ${tryUrl}`);
        const response = await fetch(tryUrl, {
          redirect: "follow",
          headers: { "User-Agent": "Mozilla/5.0 (compatible; PharmaTalent/1.0)", "Accept": "text/html" },
          signal: AbortSignal.timeout(8000),
        });

        if (response.ok && response.status === 200) {
          const html = await response.text();
          const lowerHtml = html.toLowerCase();
          const hasLeadershipSignals = (
            lowerHtml.includes("leadership") || lowerHtml.includes("executive team") ||
            lowerHtml.includes("management team") || lowerHtml.includes("our team") ||
            lowerHtml.includes("our leaders") || lowerHtml.includes("chief executive") ||
            lowerHtml.includes("chief medical") || lowerHtml.includes("board of directors") ||
            lowerHtml.includes("senior leadership")
          );
          if (hasLeadershipSignals && html.length > 1000) {
            leadershipHtml = html;
            foundLeadershipUrl = tryUrl;
            console.log(`[STAGE 1] Found leadership page: ${tryUrl}`);
            break;
          }
        }
      } catch (error) {
        console.log(`[STAGE 1] Could not fetch ${tryUrl}`);
      }
      await delay(100);
    }
  }

  // Try sitemap.xml discovery if no leadership page found
  if (!leadershipHtml && baseUrl) {
    console.log("[STAGE 1] Trying sitemap.xml discovery...");
    for (const sitemapPath of ["/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml"]) {
      try {
        const resp = await fetch(baseUrl.replace(/\/$/, "") + sitemapPath, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; PharmaTalent/1.0)" },
          redirect: "follow",
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) continue;
        const xml = await resp.text();
        const urlMatches = xml.match(/<loc>(https?:\/\/[^<]+)<\/loc>/gi) || [];
        const leadershipKeywords = ["leader", "team", "management", "executive", "people", "who-we-are"];
        for (const match of urlMatches) {
          const sitemapUrl = match.match(/<loc>(https?:\/\/[^<]+)<\/loc>/i)?.[1] || "";
          if (leadershipKeywords.some(kw => sitemapUrl.toLowerCase().includes(kw))) {
            console.log(`[STAGE 1] Found leadership page via sitemap: ${sitemapUrl}`);
            try {
              const pageResp = await fetch(sitemapUrl, {
                redirect: "follow",
                headers: { "User-Agent": "Mozilla/5.0 (compatible; PharmaTalent/1.0)", "Accept": "text/html" },
                signal: AbortSignal.timeout(8000),
              });
              if (pageResp.ok) {
                const html = await pageResp.text();
                if (html.length > 1000) {
                  leadershipHtml = html;
                  foundLeadershipUrl = sitemapUrl;
                  break;
                }
              }
            } catch (_) {}
          }
        }
        if (leadershipHtml) break;
      } catch (_) {}
    }
  }

  if (!leadershipHtml) {
    console.log("[STAGE 1] No leadership page found");
    return people;
  }

  // Strip scripts/styles, keep up to 80000 chars for GPT
  const cleanHtml = leadershipHtml
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .substring(0, 80000);

  // v20: FOCUSED extraction — only drug development pipeline roles
  const companyType = companyRecord.company_type?.toLowerCase() || "";
  const isBiotech = companyType.includes("biotech") || companyType.includes("small");

  const extractPrompt = `Extract leadership team members from this HTML page, but ONLY people relevant to the drug development pipeline.

INCLUDE these roles (our 4 focus areas):
1. RESEARCH & DISCOVERY (Phase I): Head/VP/Director of Research, R&D, Discovery, Biology, Chemistry, Preclinical
2. TRANSLATIONAL MEDICINE (Phase II): Head/VP/Director of Translational Medicine, Translational Research, Biomarkers
3. CLINICAL DEVELOPMENT (Phase III): Head/VP/Director of Clinical Development, Clinical Operations, Clinical Trials, Medical Affairs, Medical Director
4. REGULATORY AFFAIRS (post Phase III): Head/VP/Director of Regulatory Affairs, Regulatory Strategy

ALSO INCLUDE:
- C-suite executives: CEO, CSO, CMO, COO, CTO (they are key decision-makers)
- Head/VP of Drug Development, Neurology, Neuroscience, Neuromuscular, Rare Disease, Gene Therapy
${isBiotech ? "- At this biotech company, also include: Chief Scientific Officer, Head of Pipeline, Head of Programs, General Manager (they often oversee the whole asset)" : ""}

EXCLUDE (these are NOT relevant to our business):
- Finance, Accounting, CFO (unless it's a tiny biotech with <20 people)
- HR, Talent Acquisition, People Operations
- Legal, General Counsel, Compliance (unless regulatory compliance)
- Marketing, Commercial, Sales, Market Access, Business Development
- Communications, Corporate Affairs, Public Relations, Government Affairs
- IT, Engineering, Data/Analytics (unless translational/clinical data)
- Supply Chain, Manufacturing, CMC, Quality, Operations (unless clinical operations)
- Admin, Executive Assistants, Office Management
- Board of Directors (unless they are also executives)

Return JSON: {"people": [{"name": "Full Name", "title": "Job Title"}]}
Only include people whose title clearly falls in the INCLUDE categories. When in doubt, EXCLUDE.

HTML:
${cleanHtml}`;

  try {
    const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You extract leadership team members from HTML, but ONLY those relevant to the drug development pipeline (Research, Translational, Clinical, Regulatory, and C-suite). You strictly EXCLUDE finance, HR, legal, marketing, communications, commercial, supply chain, IT, and admin roles. Return valid JSON only." },
          { role: "user", content: extractPrompt },
        ],
        temperature: 0,
        max_tokens: 2000,
        response_format: { type: "json_object" },
      }),
    });

    if (openaiResp.ok) {
      const openaiData = await openaiResp.json();
      const content = openaiData.choices?.[0]?.message?.content || "{}";
      const parsed = JSON.parse(content);
      const leadershipPeople = Array.isArray(parsed) ? parsed : (parsed.people || parsed.data || []);

      console.log(`[STAGE 1] GPT extracted ${leadershipPeople.length} people from leadership page`);
      if (_diag.leadershipPage) _diag.leadershipPage.gptExtracted = leadershipPeople.length;

      // v19: PARALLEL LinkedIn lookups in batches of 4
      const LEADERSHIP_BATCH_SIZE = 4;
      for (let i = 0; i < leadershipPeople.length; i += LEADERSHIP_BATCH_SIZE) {
        const batch = leadershipPeople.slice(i, i + LEADERSHIP_BATCH_SIZE);
        const batchResults = await Promise.allSettled(
          batch.map(async (person: { name: string; title: string }) => {
            if (!person.name) return null;
            console.log(`[STAGE 1] Leadership: ${person.name} — ${person.title}`);

            try {
              const searchUrl = new URL(`https://${RAPIDAPI_HOST}/search-people`);
              searchUrl.searchParams.set("company", normalizedName);
              searchUrl.searchParams.set("keywordTitle", person.name);
              searchUrl.searchParams.set("start", "0");
              const resp = await fetch(searchUrl.toString(), {
                headers: { "x-rapidapi-key": RAPIDAPI_KEY, "x-rapidapi-host": RAPIDAPI_HOST },
              });
              const data = await resp.json();
              const items = data?.data?.items || data?.data?.data?.items || [];

              const targetParts = person.name.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter((w: string) => w.length > 1);
              let bestMatch: any = null;

              for (const item of items.slice(0, 5)) {
                if (!item?.profileURL || !item?.fullName) continue;
                const candidateParts = (item.fullName || "").toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter((w: string) => w.length > 1);

                const matchingParts = targetParts.filter((tp: string) =>
                  candidateParts.some((cp: string) => cp === tp || cp.startsWith(tp) || tp.startsWith(cp))
                );
                const matchRatio = matchingParts.length / Math.max(targetParts.length, 1);

                if (matchingParts.length >= 2 || (matchRatio >= 0.6 && matchingParts.length >= 1 && targetParts.length <= 2)) {
                  bestMatch = item;
                  console.log(`[STAGE 1] Name verified: "${item.fullName}" matches "${person.name}" (${matchingParts.length}/${targetParts.length} parts)`);
                  break;
                }
              }

              if (bestMatch?.profileURL) {
                return {
                  fullName: person.name,
                  headline: person.title || bestMatch.headline || "",
                  profileURL: bestMatch.profileURL,
                  profilePicture: bestMatch.profilePicture,
                  location: bestMatch.location,
                  summary: bestMatch.summary,
                  searchRound: "leadership_page",
                  scoringBoost: 40,
                } as SearchPerson;
              } else {
                const placeholderId = `leadership_page_${person.name.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${Date.now()}`;
                return {
                  fullName: person.name,
                  headline: person.title || "",
                  profileURL: placeholderId,
                  searchRound: "leadership_page",
                  scoringBoost: 30,
                } as SearchPerson;
              }
            } catch (e) {
              console.error(`[STAGE 1] Error searching LinkedIn for ${person.name}:`, e);
              return null;
            }
          })
        );

        // Collect results from batch
        for (const result of batchResults) {
          if (result.status === "fulfilled" && result.value) {
            people.push(result.value);
          }
        }
        // Small delay between batches to avoid rate limits
        if (i + LEADERSHIP_BATCH_SIZE < leadershipPeople.length) {
          await delay(100);
        }
      }
    }
  } catch (error) {
    console.error("[STAGE 1] Leadership extraction error:", error);
  }

  _diag.leadershipPage = {
    found: !!leadershipHtml,
    url: foundLeadershipUrl || undefined,
    gptExtracted: undefined,
    linkedinMatched: people.length,
  };
  console.log(`[STAGE 1] Leadership page yielded ${people.length} people with LinkedIn profiles`);
  return people;
}

// ============================================================================
// STAGE 1.5: JOB-INFORMED SEARCH (v19: parallelized keyword searches)
// ============================================================================

async function searchFromJobPostings(
  supabase: ReturnType<typeof createClient>,
  companyId: string,
  normalizedName: string,
  taId: string
): Promise<SearchPerson[]> {
  console.log("[STAGE 1.5] Job-informed search: looking for hiring managers...");

  const people: SearchPerson[] = [];

  try {
    const { data: jobs, error } = await supabase
      .from("job_postings")
      .select("id, title, is_neuromuscular_related")
      .eq("company_id", companyId)
      .eq("is_neuromuscular_related", true)
      .order("created_at", { ascending: false })
      .limit(5);

    if (error || !jobs || jobs.length === 0) {
      console.log("[STAGE 1.5] No NM job postings found, skipping job-informed search");
      return [];
    }

    console.log(`[STAGE 1.5] Found ${jobs.length} NM job postings`);

    // Extract unique title keywords from job postings
    const searchKeywords: string[] = [];
    const searchedKeywords = new Set<string>();

    for (const job of jobs) {
      const title = job.title || "";
      console.log(`[STAGE 1.5] Job: "${title}"`);

      // Pattern 1: "Head of X"
      const headOfMatch = title.match(/Head\s+of\s+[\w\s]+/i);
      if (headOfMatch) {
        let keyword = headOfMatch[0].replace(/[,\-\u2013]/g, " ").replace(/\s+(neuromuscular|nmd|sma|als|dmd|rare\s+disease)\s*$/i, "").trim();
        if (keyword.split(/\s+/).length <= 5 && !searchedKeywords.has(keyword.toLowerCase())) {
          searchedKeywords.add(keyword.toLowerCase());
          searchKeywords.push(keyword);
        }
      }

      // Pattern 2: "Director of X" or "VP of X"
      const directorMatch = title.match(/(Director|VP|Vice\s+President)\s+(?:of\s+)?[\w\s]+/i);
      if (directorMatch) {
        let keyword = directorMatch[0].replace(/[,\-\u2013]/g, " ").replace(/\s+(neuromuscular|nmd|sma|als|dmd|rare\s+disease)\s*$/i, "").trim();
        if (keyword.split(/\s+/).length <= 5 && !searchedKeywords.has(keyword.toLowerCase())) {
          searchedKeywords.add(keyword.toLowerCase());
          searchKeywords.push(keyword);
        }
      }
    }

    // v19: Run all job keyword searches in parallel
    if (searchKeywords.length > 0) {
      console.log(`[STAGE 1.5] Searching ${searchKeywords.length} job keywords in parallel`);
      const results = await Promise.allSettled(
        searchKeywords.map(keyword =>
          searchWithPagination(normalizedName, keyword, `job_informed_${keyword.replace(/\s+/g, "_")}`)
        )
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          for (const p of result.value) {
            p.scoringBoost = Math.max(p.scoringBoost, 35);
            p.searchRound = "job_informed";
            people.push(p);
          }
        }
      }
    }

    console.log(`[STAGE 1.5] Job-informed search found ${people.length} candidates`);
  } catch (err) {
    console.error("[STAGE 1.5] Job-informed search error:", err);
  }

  return people;
}

// ============================================================================
// HELPER: Run search tasks in parallel batches
// ============================================================================

interface SearchTask {
  fn: () => Promise<SearchPerson[] | { people: SearchPerson[]; total: number }>;
  boost: number;
  isPaginated: boolean; // true = fn returns SearchPerson[], false = fn returns {people, total}
}

async function runSearchBatches(
  tasks: SearchTask[],
  batchSize: number = 5
): Promise<SearchPerson[]> {
  const allResults: SearchPerson[] = [];

  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(tasks.length / batchSize);
    console.log(`[STAGE 1] Running batch ${batchNum}/${totalBatches} (${batch.length} searches)...`);

    const results = await Promise.allSettled(batch.map(t => t.fn()));

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const task = batch[j];
      if (result.status === "fulfilled") {
        let people: SearchPerson[];
        if (task.isPaginated) {
          people = result.value as SearchPerson[];
        } else {
          people = (result.value as { people: SearchPerson[]; total: number }).people;
        }
        if (task.boost > 0) {
          for (const p of people) {
            p.scoringBoost = Math.max(p.scoringBoost, task.boost);
          }
        }
        allResults.push(...people);
      }
    }

    // Small delay between batches to stay within rate limits
    if (i + batchSize < tasks.length) {
      await delay(80);
    }
  }

  return allResults;
}

// ============================================================================
// MAIN SEARCH ORCHESTRATOR (v19: FULLY PARALLELIZED)
// ============================================================================

export async function searchAllPeople(
  companyName: string,
  normalizedName: string,
  taId: string,
  keywords: string | undefined,
  companyRecord: CompanyRecord,
  isNMFocused: boolean,
  supabase?: ReturnType<typeof createClient>
): Promise<SearchPerson[]> {
  const allPeople = new Map<string, SearchPerson>();

  // Helper to add people to map with dedup
  function addPeople(people: SearchPerson[]) {
    for (const p of people) {
      const key = p.profileURL.startsWith("leadership_page")
        ? `leadership_${p.fullName.toLowerCase().replace(/[^a-z]/g, "")}`
        : extractLinkedInUsername(p.profileURL);
      if (key && !allPeople.has(key)) {
        allPeople.set(key, p);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1: Leadership page + Job-informed search IN PARALLEL
  // These are independent and both take significant time
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("[STAGE 1] PHASE 1: Leadership page + Job-informed search (parallel)...");

  const phase1Results = await Promise.allSettled([
    searchLeadershipPage(companyRecord, normalizedName),
    (supabase && companyRecord.company_id)
      ? searchFromJobPostings(supabase, companyRecord.company_id, normalizedName, taId)
      : Promise.resolve([]),
  ]);

  if (phase1Results[0].status === "fulfilled") addPeople(phase1Results[0].value);
  if (phase1Results[1].status === "fulfilled") addPeople(phase1Results[1].value);

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 2: User keywords (if any) — parallel
  // ═══════════════════════════════════════════════════════════════════════════
  if (keywords) {
    const expandedKeywords = expandKeywords(keywords || undefined);
    console.log(`[STAGE 1] PHASE 2: User keywords (${expandedKeywords.length} keywords, parallel)...`);

    const keywordResults = await Promise.allSettled(
      expandedKeywords.map(kw => searchWithPagination(normalizedName, kw, `keyword_${kw}`))
    );
    for (const result of keywordResults) {
      if (result.status === "fulfilled") {
        for (const p of result.value) p.scoringBoost = Math.max(p.scoringBoost, 25);
        addPeople(result.value);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 3: All standard rounds — batched parallel (5 concurrent)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("[STAGE 1] PHASE 3: Standard search rounds (batched parallel)...");

  const n = normalizedName;

  // Build all search tasks
  const searchTasks: SearchTask[] = [];

  // C-Suite (7 searches, no pagination needed — small result sets)
  for (const title of ["CEO", "CMO", "CSO", "COO", "CFO", "CTO", "Chief Technical Officer"]) {
    searchTasks.push({
      fn: () => searchPeopleRound(n, title, `c_suite_${title}`),
      boost: 0,
      isPaginated: false,
    });
  }

  // Head of titles — focused on 4 pillars (WITH pagination — high value)
  for (const title of [
    // Pillar 1: Research & Discovery
    "Head of Research", "Head of R&D", "Head of Discovery",
    // Pillar 2: Translational
    "Head of Translational", "Head of Biomarkers",
    // Pillar 3: Clinical Development
    "Head of Clinical", "Head of Medical", "Head of Medical Affairs",
    // Pillar 4: Regulatory
    "Head of Regulatory",
    // Cross-pillar: Drug Development + Disease area
    "Head of Drug Development", "Head of Development",
    "Head of Neurology", "Head of Neuroscience", "Head of Biologics",
  ]) {
    searchTasks.push({
      fn: () => searchWithPagination(n, title, `head_of_${title.replace(/\s+/g, "_")}`),
      boost: 20,
      isPaginated: true,
    });
  }

  // VP/Director (6 searches)
  for (const title of [
    "Vice President", "SVP", "Executive Director",
    "Director", "Senior Director", "Associate Director",
  ]) {
    searchTasks.push({
      fn: () => searchPeopleRound(n, title, `vp_director_${title}`),
      boost: 0,
      isPaginated: false,
    });
  }

  // 4 Pillars — pipeline-focused searches
  for (const title of [
    // Pillar 1: Research & Discovery
    "Research", "Discovery", "Preclinical",
    // Pillar 2: Translational
    "Translational Medicine", "Translational Research", "Biomarkers",
    // Pillar 3: Clinical Development
    "Clinical Development", "Clinical Operations", "Medical Affairs", "Medical Director",
    // Pillar 4: Regulatory
    "Regulatory Affairs", "Regulatory",
    // Cross-pillar
    "Drug Development",
  ]) {
    searchTasks.push({
      fn: () => searchPeopleRound(n, title, `pillar_${title.replace(/\s+/g, "_")}`),
      boost: 0,
      isPaginated: false,
    });
  }

  // NM-specific with pagination (5 searches, only if NM-focused)
  if (isNMFocused) {
    for (const title of [
      "Neuromuscular", "Neurology", "Rare Disease",
      "Gene Therapy", "Muscle",
    ]) {
      searchTasks.push({
        fn: () => searchWithPagination(n, title, `nm_specific_${title}`),
        boost: 0,
        isPaginated: true,
      });
    }
  }

  // Broad search (2 searches)
  searchTasks.push({
    fn: () => searchPeopleRound(n, "", "broad_0", 0),
    boost: 0,
    isPaginated: false,
  });
  searchTasks.push({
    fn: () => searchPeopleRound(n, "", "broad_10", 10),
    boost: 0,
    isPaginated: false,
  });

  console.log(`[STAGE 1] Total search tasks: ${searchTasks.length} (running in batches of 5)`);

  // Run all tasks in parallel batches of 5
  const batchResults = await runSearchBatches(searchTasks, 5);
  addPeople(batchResults);

  console.log(`[STAGE 1] Total unique people found: ${allPeople.size}`);
  return Array.from(allPeople.values());
}
