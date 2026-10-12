# Veridium roadmap

Ideas to build once the core profile → roster → application loop is deployed and has real users.
Status reflects what's in the code today (October 2026).

| Idea | Description | Why it matters | Status |
|---|---|---|---|
| **Player directory / search** | Orgs browse and filter players by game, rank, region and role, not just react to applicants on a posted vacancy. | Lets orgs scout proactively, closer to how recruiting really works beyond job postings. | Shipped |
| **Notifications** | On-site notifications for new applicants, application accepted/rejected and other activity, instead of checking back by hand. | Makes the application flow feel alive for both players and orgs. | Shipped (on-site bell) |
| **Org verification / profile page** | A public org profile (history, current roster, a manually confirmed "verified" badge) so players can check an org is legitimate before applying. | Protects players from fake or scam postings once applications are public. | Shipped |
| **Follow / connections** | Players and orgs follow each other, with follower counts and a feed of activity from who you follow. | Gives people a reason to open Veridium regularly, not only when job-hunting or recruiting. | Shipped |
| **Tournament / team history as a credential** | Self-reported team history first; later, tournament results through a tournament-organizer portal, as separate verification tiers alongside Riot data. | Strengthens a profile's credibility beyond rank and win rate. | Shipped (team history and tournament results) |
| **Friends / contacts sync** | On sign-up, connect Discord or a game client's friends list and see which friends are already on Veridium. | An invite loop like LinkedIn's address-book sync, pointed at gaming social graphs. | Blocked: the Discord half needs a registered Discord application; the Riot half needs an approved Riot production key |
| **Email notifications** | Send the same events the on-site bell covers (new applicant, accept/reject, roster changes) as emails, for people who aren't actively checking the site. | Catches people who wouldn't otherwise see time-sensitive activity, like an application being accepted. | Built, switched off until a Brevo API key and verified sender are set |
| **Tournament-organizer portal** | A portal for tournament organizers to submit verified results, feeding the "Tournament results" section under the profile's Teams tab. | Completes the third credential tier (Riot stats, team history, tournament results) from the original concept. | Shipped |
