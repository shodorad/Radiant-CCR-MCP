# Hosting cost estimate (decision 2)

**Recommendation:** one VM with 2 vCPU and 4 GB RAM, running all five containers. Drupal + MariaDB is the heaviest part, and the POC has a handful of editors and testers.

| Option | Size | Approx. monthly | Notes |
|---|---|---|---|
| Hetzner Cloud | 2–3 vCPU / 4 GB | ~€5–10 | Cheapest. EU or US regions |
| DigitalOcean Droplet | 2 vCPU / 4 GB | ~$24 (+20% for backups) | Simple. Good docs |
| AWS Lightsail | 2 vCPU / 4 GB | ~$24 | Fits if Radiant already uses AWS |

Prices are approximate. **Check the provider's current pricing page before quoting them.**

Other costs:
- **DNS:** two subdomains of an existing Radiant domain. No cost.
- **TLS:** Let's Encrypt through Caddy. No cost.
- **Anthropic API:** phase 2 only, and only for the writing assistant. Usage-based, small at POC volume.

**Not included:** managed database, CDN, SSO and monitoring. They're out of scope for the POC, as the plan says.
