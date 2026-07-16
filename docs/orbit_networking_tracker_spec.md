# Orbit / Constellation — Personal Networking Tracker App Spec

## 1. Product Vision

Orbit is a personal networking intelligence app that helps users remember, organize, and act on every meaningful relationship in their network.

The core idea is simple: users should never lose track of someone they have spoken to, met at an event, connected with on LinkedIn, emailed, or messaged. Orbit turns messy networking notes, LinkedIn exports, message history, and manual updates into a structured relationship database powered by AI.

The app should feel like a personal CRM, memory system, and relationship assistant combined.

The long-term vision is to represent a user's network like a constellation or solar system: every person is a node, every interaction strengthens or weakens the connection, and the user can visually explore their professional universe.

---

## 2. Name Direction

### Option A: Orbit
**Meaning:** People move around your professional life like planets in orbit. Some are close, some are distant, and some become more important depending on your goals.

**Brand feel:** Clean, modern, fast, startup-friendly, easy to remember.

### Option B: Constellation
**Meaning:** Your relationships form patterns. The app helps you see how people, companies, opportunities, and communities connect.

**Brand feel:** More visual, thoughtful, premium, relationship-focused.

### Current Recommendation
Use **Orbit** as the product name and use **Constellation View** as the name of the future graph/solar-system visualization page.

---

## 3. Target Users

### Primary Users
- Students recruiting for internships or full-time roles
- Startup founders tracking investors, mentors, customers, and advisors
- Professionals who network frequently
- Sales, recruiting, venture, and community-building users
- People attending conferences, summits, hackathons, and industry events

### Example User Persona
A college student attends a conference, talks to 15 people, connects with 8 on LinkedIn, and has 3 follow-up conversations. Instead of forgetting who said what, they paste quick notes into Orbit. The app parses the notes, updates each contact, creates follow-up reminders, and lets the user ask:  
> “Who should I reach out to about AI infrastructure internships?”

---

## 4. Core Problem

Networking is valuable but hard to manage.

Users often have important relationships scattered across:
- LinkedIn connections
- LinkedIn messages
- Gmail
- Notes app
- Calendar events
- Text messages
- Conference notes
- Spreadsheets
- Memory

This causes people to:
- Forget who they talked to
- Miss follow-ups
- Lose context before calls
- Fail to convert conversations into opportunities
- Underuse their existing network
- Struggle to remember who can help with a specific goal

Orbit solves this by making relationship data structured, searchable, visual, and actionable.

---

## 5. Product Goals

### Main Goals
1. Help users capture every meaningful contact quickly.
2. Use AI to turn rough notes into structured relationship data.
3. Let users search and chat with their network.
4. Recommend who to reach out to based on goals, interests, and timing.
5. Track relationship strength and follow-up history.
6. Visualize the user's network as a graph.
7. Support CSV imports from LinkedIn connections and message history.
8. Store data securely in a scalable per-user database.
9. Allow users to connect their own OpenAI or ChatGPT API configuration.
10. Build a polished, simple, modern UI similar in feel to Simplify.

---

## 6. Non-Goals for V1

The first version should avoid becoming too broad.

V1 should not try to:
- Replace LinkedIn
- Become a full enterprise CRM
- Automatically scrape private platforms without user consent
- Send automated messages without user approval
- Support every communication platform at launch
- Build the full solar-system visualization immediately
- Overcomplicate relationship scoring before enough data exists

---

## 7. Key Features

## 7.1 Contact Database

Each user should have a private database of people they know or have interacted with.

### Contact Fields
Each person should include:

- Full name
- Current role/title
- Company
- Location
- Email
- LinkedIn URL
- Phone number, optional
- Profile photo, optional
- Tags
- Industry
- Relationship category
- Source of contact
- First interaction date
- Last interaction date
- Next follow-up date
- Relationship closeness score, 1-5
- Notes
- AI-generated summary
- Key facts about the person
- Shared interests
- Opportunities discussed
- How the user met them
- Mutual connections
- Conversation history
- Follow-up status
- Priority level

### Relationship Closeness Scale
Use a simple 1-5 score.

| Score | Meaning |
|---|---|
| 1 | Weak connection / barely know them |
| 2 | Light connection / met once or exchanged messages |
| 3 | Moderate connection / had a real conversation |
| 4 | Strong connection / they know the user well |
| 5 | Very strong connection / mentor, close collaborator, close friend, advocate |

The score can be manually edited by the user and optionally suggested by AI.

---

## 7.2 AI Note Parsing

Users should be able to paste rough notes, and the app should convert them into structured contact data.

### Example Input
```text
Met Sarah Chen at AWS Summit. She works at OpenAI on Codex partnerships. We talked about developer tools, AI coding assistants, and my AWS internship. She said I should follow up in 2 weeks and send her my Case Closed demo.
```

### AI Output
```json
{
  "name": "Sarah Chen",
  "company": "OpenAI",
  "role": "Codex partnerships",
  "met_at": "AWS Summit",
  "topics": ["developer tools", "AI coding assistants", "AWS internship", "Case Closed"],
  "follow_up_recommendation": "Send Case Closed demo in 2 weeks",
  "relationship_score_suggestion": 2,
  "tags": ["AI", "OpenAI", "Codex", "Developer Tools"],
  "summary": "Met Sarah at AWS Summit and discussed Codex, AI-assisted development, and Case Closed. Follow up with demo."
}
```

### Parsing Requirements
The AI parser should extract:
- Person identity
- Company
- Role
- Event/context
- Topics discussed
- Action items
- Follow-up timing
- User interests mentioned
- Opportunities discussed
- Relationship strength estimate
- Tags
- Important memorable facts
- Suggested next message

---

## 7.3 LinkedIn CSV Import

Users should be able to upload:
1. LinkedIn connections export
2. LinkedIn messages export, if available

### Import Goals
The system should:
- Parse CSV rows
- Detect duplicates
- Create contacts
- Enrich existing contacts
- Attach message history to the right person
- Extract relationship context from messages
- Suggest tags
- Suggest closeness scores
- Identify people worth following up with

### Duplicate Detection
Duplicates should be matched using:
- LinkedIn URL
- Email
- Full name + company
- Full name + title
- Message history
- Fuzzy matching

The app should show possible duplicates before merging.

---

## 7.4 Manual Contact Creation

Users should also be able to manually add a contact.

### Manual Add Options
- Quick add
- Full contact form
- Paste notes and let AI fill the form
- Import from CSV
- Import from email/message later

---

## 7.5 Chat With Your Network

Users should be able to ask questions about their connections.

### Example Questions
- “Who should I reach out to about software engineering internships?”
- “Who do I know at AWS?”
- “Who have I not followed up with in the last 30 days?”
- “Who knows about AI agents?”
- “Who could introduce me to someone at OpenAI?”
- “Who did I meet at the AWS DC Summit?”
- “Who are my strongest connections in fintech?”
- “Draft a follow-up message to everyone I met last week.”
- “Which connections are most relevant to Case Closed?”
- “Who should I ask for advice about product management?”

### Chat Requirements
The assistant should:
- Search across structured contact data
- Search notes and message history
- Explain why it recommended someone
- Cite the relevant contact notes internally in the UI
- Draft personalized follow-up messages
- Recommend next actions
- Avoid hallucinating contacts that do not exist

---

## 7.6 Follow-Up Reminders

The app should help users maintain relationships over time.

### Reminder Types
- Manual reminders
- AI-suggested reminders
- Recurring relationship check-ins
- Event-based reminders
- Opportunity-based reminders
- Dormant relationship reminders

### Example Reminder Logic
- If the user met someone at an event and no follow-up happened within 7 days, suggest follow-up.
- If someone was marked as high priority but has not been contacted in 30 days, suggest check-in.
- If a person mentioned an opportunity, remind the user before the deadline.
- If the user asks about a goal, suggest relevant people to contact.

---

## 7.7 Automatic Suggestions

Orbit should proactively suggest actions.

### Suggested People to Reach Out To
Suggestions can be based on:
- User goals
- Current interests
- Upcoming deadlines
- Recent events
- Dormant high-value contacts
- Strong connections at target companies
- Contacts with relevant expertise
- Contacts who previously offered help
- People the user recently imported but has not messaged

### Example Suggestions
- “You met 6 people at AWS Summit and have not followed up with 4 of them.”
- “You are interested in Codex. You have 3 OpenAI-related contacts.”
- “You have not spoken to Maya in 45 days, and she previously offered to introduce you to someone.”
- “You are applying to fintech roles. These 5 people are most relevant.”

---

## 7.8 Graph View

Orbit should include a graph representation of the user's network.

### V1 Graph View
A simple interactive node graph:
- User at the center
- Contacts as nodes
- Companies as grouped clusters
- Tags as filters
- Relationship strength shown visually
- Recently contacted people highlighted
- Dormant contacts dimmed

### Future Constellation View
A more graphical solar-system style visualization:
- User is the sun or center point
- Strong contacts orbit closer
- Weak contacts orbit farther away
- Companies become planets or clusters
- Industries become regions of space
- Opportunities appear as glowing paths
- Follow-up reminders appear as signals or alerts
- Search questions can visually highlight relevant people

---

## 8. UI / UX Direction

The UI should be clean, fast, modern, and polished.

### Inspiration
The interface should feel similar to Simplify:
- Minimal
- Smooth
- Modern
- High-trust
- Useful immediately
- Great empty states
- Fast onboarding
- Clear cards
- Helpful AI suggestions
- Light but premium visual polish

### Design Principles
- Capture should be extremely fast.
- AI should reduce manual data entry.
- The user should always understand why a recommendation was made.
- Relationship data should feel alive, not static.
- The graph should be beautiful but still useful.
- The app should work well for students and professionals.

---

## 9. Main Pages

## 9.1 Dashboard

The dashboard should show:
- Suggested follow-ups
- Recently added contacts
- High-priority contacts
- Upcoming reminders
- Recent interactions
- AI recommendations
- Network health summary

### Example Dashboard Cards
- “5 people to follow up with this week”
- “3 new LinkedIn imports need review”
- “You have 8 strong contacts in AI”
- “2 people mentioned internship opportunities”
- “Your closest company cluster is AWS”

---

## 9.2 Contacts Page

A searchable, filterable list of all people.

### Filters
- Company
- Role
- Industry
- Location
- Tags
- Closeness score
- Last contacted
- Source
- Priority
- Follow-up status

---

## 9.3 Contact Profile Page

Each contact gets a rich profile.

### Sections
- Basic info
- Relationship score
- Summary
- Timeline of interactions
- Notes
- AI insights
- Follow-up reminders
- Related people
- Related companies
- Suggested next message
- Opportunities discussed

---

## 9.4 Add Contact / Log Interaction Page

This should be one of the most important flows.

### Input Methods
- Paste rough notes
- Upload CSV
- Manual form
- Add interaction to existing contact
- Import from LinkedIn
- Later: Gmail or calendar integration

### AI Review Step
After parsing, show a confirmation screen:
- Extracted person
- Extracted fields
- Suggested score
- Suggested tags
- Suggested reminder
- Suggested summary

The user should be able to edit before saving.

---

## 9.5 Chat Page

A chat interface for asking questions about the user's network.

### Chat Features
- Natural language Q&A
- Contact recommendations
- Follow-up drafting
- Search across notes
- Action creation
- Reminder creation
- Explainability

---

## 9.6 Imports Page

A place to manage CSV imports.

### Features
- Upload LinkedIn connections CSV
- Upload LinkedIn messages CSV
- Preview rows
- Map columns
- Deduplicate contacts
- Confirm import
- See import history

---

## 9.7 Graph / Constellation Page

### V1
A practical graph showing:
- Contacts
- Companies
- Tags
- Relationship strength
- Interaction recency

### Future
A highly visual, solar-system-inspired interface.

---

## 9.8 Settings Page

Settings should include:
- User profile
- AI provider configuration
- OpenAI API key / ChatGPT connection
- Data export
- Data deletion
- Notification preferences
- Import preferences
- Privacy controls

---

## 10. AI Architecture

## 10.1 AI Tasks

The LLM should support:
- Parsing notes
- Extracting structured data
- Summarizing people
- Generating tags
- Estimating closeness score
- Recommending follow-ups
- Drafting messages
- Answering questions
- Matching people to goals
- Finding opportunities
- Detecting duplicates
- Updating contact profiles from new interactions

## 10.2 Custom OpenAI / ChatGPT Connection

Users should be able to connect their own AI provider settings.

### Possible Options
- Bring your own OpenAI API key
- Default hosted AI mode
- Model selection
- Privacy mode
- Disable AI memory on sensitive notes
- Choose which data AI can access

### Important UX Requirement
AI configuration should be simple. Most users should not need to understand technical settings.

---

## 11. Data Model

## 11.1 Users Table

```text
users
- id
- name
- email
- profile_image_url
- created_at
- updated_at
```

## 11.2 Contacts Table

```text
contacts
- id
- user_id
- full_name
- first_name
- last_name
- company
- title
- location
- email
- phone
- linkedin_url
- profile_image_url
- relationship_score
- priority_level
- source
- first_interaction_at
- last_interaction_at
- next_follow_up_at
- ai_summary
- notes
- created_at
- updated_at
```

## 11.3 Interactions Table

```text
interactions
- id
- user_id
- contact_id
- interaction_type
- interaction_date
- source
- raw_notes
- ai_summary
- topics
- action_items
- sentiment
- created_at
```

## 11.4 Tags Table

```text
tags
- id
- user_id
- name
- created_at
```

## 11.5 Contact Tags Table

```text
contact_tags
- contact_id
- tag_id
```

## 11.6 Reminders Table

```text
reminders
- id
- user_id
- contact_id
- title
- description
- due_date
- status
- reminder_type
- created_by
- created_at
```

## 11.7 Imports Table

```text
imports
- id
- user_id
- import_type
- file_name
- status
- rows_processed
- contacts_created
- contacts_updated
- duplicates_found
- created_at
```

## 11.8 AI Suggestions Table

```text
ai_suggestions
- id
- user_id
- suggestion_type
- title
- description
- related_contact_ids
- confidence_score
- status
- created_at
```

## 11.9 Embeddings Table

```text
contact_embeddings
- id
- user_id
- contact_id
- source_type
- source_id
- embedding
- content
- created_at
```

---

## 12. Search and Retrieval

The app should support both structured filtering and semantic search.

### Structured Search
Used for:
- Company
- Role
- Tags
- Dates
- Relationship score
- Follow-up status

### Semantic Search
Used for:
- “Who knows about AI agents?”
- “Who can help with venture capital?”
- “Who did I talk to about Codex?”
- “Who might know someone at fintech companies?”

### Recommended Approach
Use a relational database for core records and vector embeddings for notes, summaries, and message history.

---

## 13. Suggested Tech Stack

### Frontend
- Next.js
- React
- TypeScript
- Tailwind CSS
- shadcn/ui
- Framer Motion
- React Flow or Sigma.js for graph visualization

### Backend
- Next.js API routes or dedicated backend
- Node.js / TypeScript
- PostgreSQL
- Prisma or Drizzle ORM

### Database
- Supabase Postgres or Neon
- pgvector for semantic search
- Row-level security for per-user data

### Authentication
- Clerk, Supabase Auth, or Auth.js

### AI
- OpenAI API
- Optional provider abstraction for future models
- Structured JSON extraction
- Embeddings for semantic search

### File Processing
- CSV parser
- Background import jobs
- Duplicate detection system

### Notifications
- Email reminders
- In-app notifications
- Later: push notifications
- Later: calendar integration

---

## 14. Security and Privacy

Because Orbit stores personal relationship data, privacy is a major requirement.

### Requirements
- Data must be scoped per user.
- Users should only access their own contacts.
- API keys should be encrypted.
- Users should be able to delete all data.
- Users should be able to export all data.
- Uploaded CSV files should be processed securely.
- Sensitive notes should not be exposed to other users.
- AI access should be clear and controllable.
- Logs should avoid storing unnecessary private data.

---

## 15. MVP Scope

## 15.1 MVP Must-Haves

The first version should include:

1. Authentication
2. Contact database
3. Manual contact creation
4. AI note parsing
5. Relationship score 1-5
6. Tags
7. Interaction logging
8. Contact profile pages
9. Dashboard with follow-up suggestions
10. LinkedIn connections CSV import
11. Basic chat with your network
12. Basic semantic search
13. Reminder creation
14. Simple graph view
15. Per-user database security

---

## 15.2 MVP Nice-to-Haves

- LinkedIn message history import
- Gmail integration
- Calendar integration
- Browser extension
- Automatic profile enrichment
- Advanced graph clustering
- AI-generated follow-up drafts
- Notification emails
- Opportunity matching

---

## 16. User Stories

### Contact Capture
As a user, I want to paste rough notes after meeting someone so that Orbit can automatically create or update their profile.

### LinkedIn Import
As a user, I want to upload my LinkedIn connections CSV so that I can quickly populate my network.

### Relationship Memory
As a user, I want to see a timeline of every interaction with someone so that I remember the full context before reaching out.

### Follow-Up
As a user, I want Orbit to remind me who I should follow up with so that I do not miss opportunities.

### Network Chat
As a user, I want to ask questions about my network so that I can find the right person for a specific situation.

### Recommendations
As a user, I want Orbit to suggest people to contact based on my goals so that I can use my network more strategically.

### Graph View
As a user, I want to visualize my network so that I can understand which companies, communities, and people I am most connected to.

---

## 17. Example User Flows

## 17.1 Add a Contact from Notes

1. User opens “Add Interaction.”
2. User pastes messy notes.
3. AI extracts contact info, topics, action items, and suggested follow-up.
4. App checks for duplicates.
5. User reviews and edits.
6. Contact is saved.
7. Reminder is created.
8. Contact appears on dashboard and graph.

---

## 17.2 Ask the Network Chat

1. User asks: “Who should I reach out to about product management internships?”
2. System searches contacts, notes, tags, and embeddings.
3. AI returns ranked recommendations.
4. Each recommendation includes a reason.
5. User can click a person, create a reminder, or draft a message.

---

## 17.3 Import LinkedIn Connections

1. User uploads CSV.
2. App previews the data.
3. User maps columns if needed.
4. App finds duplicates.
5. AI suggests tags and summaries.
6. User confirms import.
7. Contacts are added to the database.

---

## 18. Ranking Logic for Recommendations

When suggesting people, Orbit should consider:

- Relationship score
- Relevance to the user's query
- Company relevance
- Role relevance
- Tags
- Recent interaction history
- Whether the person offered help
- Whether a follow-up is overdue
- Strength of notes
- Mutual connections
- User priority
- Opportunity relevance

### Example Ranking Formula
```text
recommendation_score =
  semantic_relevance * 0.35 +
  relationship_strength * 0.20 +
  recency_score * 0.15 +
  company_match * 0.10 +
  opportunity_match * 0.10 +
  user_priority * 0.10
```

---

## 19. AI Prompting Requirements

### Note Parser Prompt
The parser should return strict JSON.

It should:
- Extract only information supported by the notes.
- Use null when unknown.
- Suggest but not assume.
- Separate facts from guesses.
- Return confidence scores.
- Identify follow-up tasks.

### Recommendation Prompt
The recommendation system should:
- Use retrieved contacts only.
- Rank people by relevance.
- Explain each recommendation.
- Suggest a next action.
- Draft an optional message.
- Avoid inventing details.

---

## 20. Acceptance Criteria

### AI Note Parsing
- Given rough notes, the system extracts structured fields.
- The user can edit before saving.
- The system detects possible duplicate contacts.
- The system creates an interaction timeline entry.
- The system suggests a follow-up when appropriate.

### Contact Management
- Users can create, update, delete, and search contacts.
- Contacts are scoped to the logged-in user.
- Relationship score can be manually edited.
- Tags can be added and removed.

### Chat
- User can ask a question about their network.
- System retrieves relevant contacts.
- System explains why each contact was recommended.
- System does not recommend nonexistent people.

### Import
- User can upload a LinkedIn connections CSV.
- App previews imported data.
- Duplicates are detected.
- Contacts are created or updated after confirmation.

### Graph
- User can view a graph of contacts.
- User can filter by company, tag, and closeness.
- Clicking a node opens the contact profile.

---

## 21. Development Phases

## Phase 1 — Foundation
- Auth
- User database
- Contact CRUD
- Contact profile page
- Relationship score
- Tags
- Basic dashboard

## Phase 2 — AI Capture
- Paste-notes parser
- Structured extraction
- Duplicate detection
- Interaction timeline
- AI summaries
- Follow-up suggestions

## Phase 3 — Import System
- LinkedIn CSV upload
- Import preview
- Column mapping
- Duplicate merging
- Import history

## Phase 4 — Chat and Search
- Embeddings
- Semantic search
- Chat with network
- Contact recommendations
- Follow-up message drafts

## Phase 5 — Reminders and Notifications
- Manual reminders
- AI reminders
- Email notifications
- In-app notifications
- Suggested follow-ups

## Phase 6 — Graph View
- Basic graph visualization
- Company clusters
- Relationship strength indicators
- Filters

## Phase 7 — Constellation View
- Solar-system visualization
- Advanced animations
- Relationship orbit distance
- Opportunity paths
- Beautiful exploratory UI

---

## 22. Open Questions to Refine

### Product Positioning
1. Is this mainly for students, professionals, founders, salespeople, or everyone?
2. Should the tone feel more like a career CRM, personal memory app, or AI relationship assistant?
3. Should the app be optimized for recruiting/networking first, or broader relationship management?

### Name and Brand
4. Do you prefer **Orbit** or **Constellation** as the main app name?
5. Should the brand feel more professional, futuristic, playful, or premium?
6. Do you want the space theme to be subtle or very obvious?

### UI
7. What parts of Simplify do you want to copy most: dashboard, cards, minimalism, browser-extension feel, animations, or onboarding?
8. Should the app be mostly light mode, dark mode, or both?
9. Do you want the graph view to be practical first or visually impressive first?

### AI Behavior
10. Should AI be allowed to automatically create reminders, or should the user always approve them first?
11. Should AI automatically score relationship closeness, or only suggest a score?
12. Should AI draft messages in your voice based on past messages?

### Data and Integrations
13. Should Gmail and Google Calendar be part of the MVP or later?
14. Should users connect LinkedIn manually through CSV only, or should there eventually be a browser extension?
15. Should users be able to export all their contacts back into CSV?

### Relationship Scoring
16. Should closeness be manually set by the user, AI-generated, or a hybrid?
17. Should relationship strength decay over time if there is no interaction?
18. Should the score be private only, or should it influence reminders and recommendations heavily?

### Graph Visualization
19. Should people be grouped by company, event, industry, or closeness?
20. What should the solar-system view represent: closeness, opportunity value, frequency of contact, or all of them?
21. Should the user be able to drag people around and manually organize their network?

### Monetization / Future
22. Is this a personal project, startup idea, or portfolio project?
23. Would this eventually be paid SaaS?
24. Should teams or shared networks be supported later?

---

## 23. Strong MVP Definition

The best MVP version of Orbit is:

> A personal AI networking tracker where users can add contacts from rough notes, import LinkedIn connections, track relationship strength, set follow-up reminders, and ask an AI assistant who in their network can help with a specific goal.

This version is focused enough to build, impressive enough to demo, and extensible enough to become a much larger product.

---

## 24. One-Sentence Pitch

Orbit is an AI-powered personal networking tracker that turns scattered notes, LinkedIn exports, and conversations into a searchable relationship database with smart follow-up reminders and visual network maps.

---

## 25. Demo Scenario

A user attends AWS Summit and meets several people from AWS, OpenAI, startups, and recruiting teams.

They paste their notes into Orbit. Orbit:
1. Creates contact profiles.
2. Extracts companies, roles, and topics.
3. Scores relationship closeness.
4. Suggests follow-ups.
5. Adds reminders.
6. Lets the user ask, “Who should I talk to about AI-assisted development?”
7. Shows relevant people in the graph view.
8. Drafts personalized LinkedIn follow-up messages.

This creates a clear and compelling demo for students, recruiters, investors, and technical audiences.
