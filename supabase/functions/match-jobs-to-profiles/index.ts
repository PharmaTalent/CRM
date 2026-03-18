// match-jobs-to-profiles v1 — AI-powered job-to-decision-maker matching
// For every "high" relevance job, find the best DM profiles to approach
// and store matches for user review before outreach generation.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface JobPosting {
  job_id: string;
  company_name: string;
  job_title: string;
  job_url: string;
  location: string;
  seniority_level: string;
  full_description: string;
  enrichment_summary: string;
  key_requirements: Record<string, unknown>;
  nm_relevance_keywords: string[];
  therapeutic_area_id: string;
  outreach_hook: string;
}

interface DecisionMaker {
  dm_id: string;
  company_name: string;
  full_name: string;
  headline: string;
  current_title: string;
  current_company: string;
  seniority_level: string;
  role_category: string;
  location: string;
  therapeutic_areas: string[];
  key_skills: string[];
  ai_analysis: string;
  ai_fit_score: number;
  career_highlights: string;
  neuromuscular_experience: boolean;
  neurology_experience: boolean;
  clinical_trials_experience: boolean;
  years_experience: number;
  profile_url: string;
  indication_specialty: string;
  is_potential_hiring_manager: boolean;
}

interface AIMatch {
  dm_id: string;
  match_score: number;
  match_reasoning: string;
  match_factors: {
    title_alignment: number;
    seniority_fit: number;
    therapeutic_overlap: number;
    skills_match: number;
    location_proximity: number;
    hiring_manager_signal: number;
  };
  talking_points: string[];
  suggested_angle: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const openaiKey = Deno.env.get("OPENAI_API_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json();
    const {
      therapeutic_area_id,
      job_id,           // optional: match a specific job
      max_matches = 5,  // max DMs per job
      dry_run = false,
      rematch = false,  // re-run even if matches exist
    } = body;

    if (!therapeutic_area_id) {
      return new Response(JSON.stringify({ error: "therapeutic_area_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Stage 1: Fetch high-relevance jobs ──────────────────────────
    let jobQuery = supabase
      .from("job_postings")
      .select("*")
      .eq("relevance_level", "high")
      .eq("therapeutic_area_id", therapeutic_area_id);

    if (job_id) {
      jobQuery = jobQuery.eq("job_id", job_id);
    }

    const { data: jobs, error: jobErr } = await jobQuery;
    if (jobErr) throw new Error(`Failed to fetch jobs: ${jobErr.message}`);
    if (!jobs || jobs.length === 0) {
      return new Response(JSON.stringify({ success: true, message: "No high-relevance jobs found", matches_created: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[match-jobs] Found ${jobs.length} high-relevance jobs`);

    // ── Stage 2: Fetch classified decision makers ───────────────────
    const { data: allDMs, error: dmErr } = await supabase
      .from("decision_makers")
      .select("*")
      .eq("therapeutic_area_id", therapeutic_area_id)
      .not("role_category", "is", null);

    if (dmErr) throw new Error(`Failed to fetch DMs: ${dmErr.message}`);
    if (!allDMs || allDMs.length === 0) {
      return new Response(JSON.stringify({ success: true, message: "No classified decision makers found", matches_created: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[match-jobs] Found ${allDMs.length} classified DMs`);

    // ── Stage 3: Skip jobs that already have matches (unless rematch) ──
    let jobsToProcess = jobs as JobPosting[];
    if (!rematch) {
      const { data: existingMatches } = await supabase
        .from("job_dm_matches")
        .select("job_id")
        .in("job_id", jobs.map((j: JobPosting) => j.job_id));

      const alreadyMatchedJobIds = new Set((existingMatches || []).map((m: { job_id: string }) => m.job_id));
      jobsToProcess = jobsToProcess.filter(j => !alreadyMatchedJobIds.has(j.job_id));
      console.log(`[match-jobs] ${jobs.length - jobsToProcess.length} jobs already matched, processing ${jobsToProcess.length}`);
    }

    if (jobsToProcess.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: "All high-relevance jobs already have matches. Use rematch=true to re-run.",
        matches_created: 0,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Stage 4: AI matching per job ────────────────────────────────
    const allResults: Array<{
      job_id: string;
      job_title: string;
      company: string;
      matches_found: number;
      top_match: string;
    }> = [];
    let totalMatchesCreated = 0;

    // Process jobs in batches of 3
    const JOB_BATCH_SIZE = 3;
    for (let i = 0; i < jobsToProcess.length; i += JOB_BATCH_SIZE) {
      const jobBatch = jobsToProcess.slice(i, i + JOB_BATCH_SIZE);

      const batchPromises = jobBatch.map(async (job) => {
        // Pre-filter DMs: same company gets priority, but also include DMs from same TA
        const sameCoDMs = allDMs.filter(
          (dm: DecisionMaker) => dm.company_name?.toLowerCase() === job.company_name?.toLowerCase()
        );
        const otherDMs = allDMs.filter(
          (dm: DecisionMaker) => dm.company_name?.toLowerCase() !== job.company_name?.toLowerCase()
        );

        // Take all same-company DMs + top 30 others by ai_fit_score
        const candidateDMs = [
          ...sameCoDMs,
          ...otherDMs
            .sort((a: DecisionMaker, b: DecisionMaker) => (b.ai_fit_score || 0) - (a.ai_fit_score || 0))
            .slice(0, 30),
        ];

        if (candidateDMs.length === 0) return null;

        // Build AI prompt
        const jobContext = `
JOB POSTING:
- Title: ${job.job_title}
- Company: ${job.company_name}
- Location: ${job.location || "Not specified"}
- Seniority: ${job.seniority_level || "Not specified"}
- NM Keywords: ${(job.nm_relevance_keywords || []).join(", ")}
- Description: ${(job.enrichment_summary || job.full_description || "").slice(0, 1500)}
- Outreach Hook: ${job.outreach_hook || "None"}
- Key Requirements: ${JSON.stringify(job.key_requirements || {}).slice(0, 500)}
`.trim();

        const dmProfiles = candidateDMs.map((dm: DecisionMaker, idx: number) => `
[DM-${idx}] id=${dm.dm_id}
  Name: ${dm.full_name}
  Title: ${dm.current_title || dm.headline}
  Company: ${dm.current_company || dm.company_name}
  Role Category: ${dm.role_category}
  Seniority: ${dm.seniority_level}
  Location: ${dm.location || "Unknown"}
  Therapeutic Areas: ${JSON.stringify(dm.therapeutic_areas || [])}
  Key Skills: ${JSON.stringify(dm.key_skills || [])}
  NM Experience: ${dm.neuromuscular_experience}
  Years Exp: ${dm.years_experience || "Unknown"}
  AI Fit Score: ${dm.ai_fit_score || 0}
  Hiring Manager Signal: ${dm.is_potential_hiring_manager || false}
  Career Highlights: ${(dm.career_highlights || "").slice(0, 300)}
  Indication Specialty: ${dm.indication_specialty || "None"}
`.trim()).join("\n\n");

        const aiPrompt = `You are PharmaTalent's matching engine. Your job is to identify which decision-makers are the BEST people to contact about this specific open role.

The goal is to find people who:
1. HIRING MANAGERS: Could be the actual hiring manager for this role (same company, right seniority, right department)
2. INFLUENCERS: Senior leaders at the same company who influence hiring (C-suite, VPs)
3. NETWORK CONNECTORS: People at OTHER companies in the same therapeutic area who might know candidates or be candidates themselves

${jobContext}

CANDIDATE PROFILES:
${dmProfiles}

Return a JSON array of the top ${max_matches} best matches. For EACH match include:
{
  "dm_id": "the exact dm_id",
  "match_score": 0-100,
  "match_reasoning": "2-3 sentences explaining WHY this person is the right contact for this job",
  "match_factors": {
    "title_alignment": 0-100,
    "seniority_fit": 0-100,
    "therapeutic_overlap": 0-100,
    "skills_match": 0-100,
    "location_proximity": 0-100,
    "hiring_manager_signal": 0-100
  },
  "talking_points": [
    "Specific point to mention when reaching out about this role",
    "Another angle connecting their background to this job",
    "Third point if relevant"
  ],
  "suggested_angle": "HIRING_MANAGER | INFLUENCER | NETWORK_CONNECTOR"
}

SCORING GUIDELINES:
- 90-100: Almost certainly the hiring manager or direct report to hiring manager
- 75-89: Strong match - same company, right seniority, related function
- 60-74: Good match - relevant therapeutic area, could refer candidates
- 40-59: Moderate - tangential connection, worth a shot
- Below 40: Don't include

Only return matches scoring 40+. Return VALID JSON array only, no markdown.`;

        const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${openaiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [
              { role: "system", content: "You are a precise matching engine. Return only valid JSON arrays." },
              { role: "user", content: aiPrompt },
            ],
            temperature: 0.3,
            max_tokens: 4000,
          }),
        });

        if (!aiResponse.ok) {
          console.error(`[match-jobs] OpenAI error for job ${job.job_id}: ${aiResponse.status}`);
          return null;
        }

        const aiData = await aiResponse.json();
        let rawContent = aiData.choices?.[0]?.message?.content || "[]";

        // Clean markdown fences if present
        rawContent = rawContent.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

        let matches: AIMatch[];
        try {
          matches = JSON.parse(rawContent);
        } catch {
          console.error(`[match-jobs] Failed to parse AI response for job ${job.job_id}`);
          return null;
        }

        if (!Array.isArray(matches)) matches = [];

        // Filter to valid matches only
        const validDmIds = new Set(candidateDMs.map((dm: DecisionMaker) => dm.dm_id));
        matches = matches.filter(m => validDmIds.has(m.dm_id) && m.match_score >= 40);

        // Sort by score desc, take top N
        matches.sort((a, b) => b.match_score - a.match_score);
        matches = matches.slice(0, max_matches);

        if (matches.length === 0) return null;

        // ── Stage 5: Save matches ─────────────────────────────────
        if (!dry_run) {
          // If rematch, delete old matches for this job first
          if (rematch) {
            await supabase
              .from("job_dm_matches")
              .delete()
              .eq("job_id", job.job_id);
          }

          const rows = matches.map(m => ({
            job_id: job.job_id,
            dm_id: m.dm_id,
            therapeutic_area_id: therapeutic_area_id,
            company_name: job.company_name,
            match_score: m.match_score,
            match_reasoning: m.match_reasoning,
            match_factors: m.match_factors,
            talking_points: m.talking_points,
            suggested_angle: m.suggested_angle,
            status: "pending",
          }));

          const { error: insertErr } = await supabase
            .from("job_dm_matches")
            .upsert(rows, { onConflict: "job_id,dm_id" });

          if (insertErr) {
            console.error(`[match-jobs] Insert error for job ${job.job_id}: ${insertErr.message}`);
          } else {
            totalMatchesCreated += matches.length;
          }
        }

        return {
          job_id: job.job_id,
          job_title: job.job_title,
          company: job.company_name,
          matches_found: matches.length,
          top_match: matches[0]
            ? `${candidateDMs.find((dm: DecisionMaker) => dm.dm_id === matches[0].dm_id)?.full_name} (${matches[0].match_score})`
            : "none",
          matches: dry_run ? matches : undefined,
        };
      });

      const batchResults = await Promise.all(batchPromises);
      for (const r of batchResults) {
        if (r) allResults.push(r);
      }
    }

    // ── Diagnostics ─────────────────────────────────────────────────
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    await supabase.from("edge_function_diagnostics").insert({
      function_name: "match-jobs-to-profiles",
      therapeutic_area_id,
      payload: {
        version: 1,
        jobs_processed: jobsToProcess.length,
        matches_created: totalMatchesCreated,
        dry_run,
        rematch,
        duration_seconds: parseFloat(duration),
      },
    });

    return new Response(JSON.stringify({
      success: true,
      version: 1,
      dry_run,
      jobs_scanned: jobs.length,
      jobs_processed: jobsToProcess.length,
      jobs_skipped: jobs.length - jobsToProcess.length,
      total_dms_available: allDMs.length,
      total_matches_created: totalMatchesCreated,
      results: allResults,
      duration_seconds: parseFloat(duration),
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[match-jobs] Fatal error:", err);
    return new Response(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
