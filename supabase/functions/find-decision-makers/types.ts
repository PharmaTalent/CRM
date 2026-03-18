export { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================================
// TYPES
// ============================================================================

export interface SearchPerson {
  fullName: string;
  headline: string;
  profileURL: string;
  profilePicture?: string;
  location?: string;
  summary?: string;
  searchRound: string;
  scoringBoost: number;
}

export interface PreFilteredPerson {
  name: string;
  headline: string;
  profileUrl: string;
  pre_filter_score: number;
  rationale: string;
}

export interface EnrichedPerson {
  current_title: string;
  current_company: string;
  seniority_level: string;
  years_experience: number;
  education: Array<{ degree: string; field: string; school: string }>;
  clinical_trials_experience: boolean;
  leadership_experience: boolean;
  neuromuscular_experience: boolean;
  neurology_experience: boolean;
  therapeutic_areas: string[];
  key_skills: string[];
  career_highlights: string;
  ai_analysis: string;
  ai_fit_score: number;
  outreach_hook: string;
  role_category: string;
}

export interface DatabasePerson {
  dm_id: string;
  company_name: string;
  therapeutic_area_id: string;
  full_name: string;
  headline: string;
  profile_url: string;
  profile_picture?: string;
  location?: string;
  username?: string;
  summary?: string;
  relevance_score: number; // CHECK constraint: 1-10
  role_category: string;
  search_round: string;
  source_query?: string;
  is_enriched: boolean;
  enriched_at?: string;
  current_title?: string;
  current_company?: string;
  seniority_level?: string;
  years_experience?: number;
  education?: object;
  clinical_trials_experience?: boolean;
  leadership_experience?: boolean;
  neuromuscular_experience?: boolean;
  neurology_experience?: boolean;
  therapeutic_areas?: object;
  key_skills?: object;
  career_highlights?: string;
  ai_analysis?: string;
  ai_fit_score?: number;
  outreach_hook?: string;
}

export interface CompanyRecord {
  company_id: string;
  company_name: string;
  website?: string;
  nm_commitment_level?: string;
  company_type?: string;
  key_therapeutic_focus?: unknown; // jsonb column
}

// ============================================================================
// CONSTANTS & CONFIG
// ============================================================================

export const RAPIDAPI_KEY = "f45a346ac4msh311e9852a348febp118ba0jsn626e1a8c9d09";
export const RAPIDAPI_HOST = "real-time-people-company-data.p.rapidapi.com";

// Global diagnostics collector
export const _diag: {
  rounds: Array<{ round: string; url: string; status: number; rawItemCount: number; parsedCount: number; sampleKeys?: string[] }>;
  firstRawResponse?: unknown;
  leadershipPage?: { found: boolean; url?: string; gptExtracted?: number; linkedinMatched?: number };
  errors: string[];
} = { rounds: [], errors: [] };

export const KEYWORD_EXPANSION: Record<string, string[]> = {
  CMC: [
    "Chief Technical",
    "Technical Operations",
    "Manufacturing",
    "Process Development",
    "Chemistry Manufacturing",
  ],
  CMO: ["Chief Medical Officer"],
  CEO: ["Chief Executive Officer"],
  CSO: ["Chief Scientific Officer"],
  CTO: ["Chief Technology Officer", "Chief Technical Officer"],
  COO: ["Chief Operating Officer"],
  RA: ["Regulatory Affairs", "Regulatory"],
  QA: ["Quality Assurance", "Quality"],
  PD: ["Process Development"],
  BD: ["Business Development"],
};

export const LEADERSHIP_PAGE_PATTERNS = [
  "/leadership", "/team", "/our-team", "/leadership-team",
  "/our-company/leadership-team", "/our-company/leadership",
  "/about/leadership", "/about/team", "/about-us/leadership",
  "/about-us/team", "/about-us/our-team", "/about/our-team",
  "/about/management", "/about-us/management", "/management",
  "/people", "/who-we-are/leadership", "/company/leadership", "/company/team",
  "/executive-team", "/executives", "/management-team",
];

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

export function normalizeCompanyName(name: string): string {
  return name
    .replace(
      /\b(Inc\.?|LLC|Ltd\.?|Corp\.?|Corporation|Incorporated|Company|Co\.?|Pharmaceuticals?|Therapeutics?|Biosciences?|Biopharma|Biotech(nology)?|Sciences?|Medical|Healthcare|Health|Group|Holdings?|International|Global|Plc\.?|S\.?A\.?|GmbH|AG|N\.?V\.?|SE|S\.?p\.?A\.?)\b/gi,
      ""
    )
    .replace(/[,.\-()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractLinkedInUsername(profileURL?: string): string {
  if (!profileURL) return "";
  const match = profileURL.match(/linkedin\.com\/in\/([a-zA-Z0-9\-]+)/i);
  return match ? match[1] : profileURL;
}

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}