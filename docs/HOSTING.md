# Hosting

The suite needs one Linux server: Ubuntu 24.04 or 26.04, 2 vCPU, 4 GB memory,
40 GB disk, a public IPv4 address, ports 80 and 443 open. The owner chooses the
provider and pays it directly; nothing about the suite ties them to one.

What matters when choosing:

- **"User data" / cloud-init at server creation.** This is what makes the
  install a few clicks ([DEPLOY.md](DEPLOY.md), 2a). Without it, the install is
  one SSH command instead.
- **A region near the team.** Fewer milliseconds per click.
- **Snapshots or provider backups.** A second safety net next to the suite's
  own nightly backups (which should also go off-site).
- **Payment and sign-up checks** that work for the owner (card, PayPal, ID checks).
- **Price as shown, and whether VAT or sales tax is added.**

## Choosing a VPS

Researched on 2026-10-07 from each provider's own pages. Prices change often and are shown exactly as the page
showed them on that date, in the page's currency. Check the provider's order page before you buy: the order total
is the price that counts. Where a page did not load or did not say something, this section says so rather than
guessing.

### What matters for the suite

- **Size:** at least 2 vCPU, 4 GB RAM, 40 GB SSD. More disk helps if you keep many files and 14 days of local
  backups.
- **"User data" (cloud-init) at server creation:** this is the few-clicks path. The owner pastes
  `deploy/cloud-init.yaml` into the provider's "user data" or "cloud-init" box and the server sets itself up.
  Without it, the owner (or the intern) connects over SSH once and runs `deploy/install.sh`. Both work; the first is
  easier for an owner on their own.
- **Region:** pick a data centre near the people who use the suite. A server on another continent works, but pages
  feel slower. If your customers' or staff's data must stay in your country, check that before choosing a region
  abroad.
- **Backups:** the suite backs itself up every night (database and files, 14 days on the server, optional copy to
  any S3-compatible bucket). A provider backup or snapshot on top is a cheap second copy of the whole server; turn
  it on if you can.
- **The real monthly cost:** some list prices exclude VAT, the public IPv4 address or the disk, and some need you
  to pay 12 or 24 months up front, with a higher price at renewal.

### The smallest qualifying plan at each provider

| Provider | Plan (vCPU / RAM / disk) | Price as shown (2026-10-07) | Regions: US / EU / India | User data at creation | Backups and snapshots |
| --- | --- | --- | --- | --- | --- |
| Hetzner Cloud | CX23: 2 / 4 GB / 40 GB NVMe (EU only) | EUR 5.49 or USD 6.49 a month, plus the IPv4 address EUR 0.50 or USD 0.60 a month; VAT not included by default (the page has a country/VAT selector) | US: yes, but CX23 is EU only; the smallest US plan is CPX21 (3 / 4 GB / 80 GB) at USD 37.49 a month. EU: Falkenstein, Nuremberg, Helsinki. India: no | Yes ("Cloud config", up to 32 KiB) | Backups 20% of the server price; snapshots EUR 0.0143 per GB a month |
| Netcup | VPS 500 G12.5: 2 / 4 GB / 64 GB SSD | EUR 9.50 a month on a 1-month term; EUR 7.03 a month on a 24-month term; both incl. 19% German VAT (VAT follows your country); no setup fee | US: Manassas. EU: Nuremberg, Vienna, Amsterdam. India: no. Some locations cost EUR 1.04 to 7.66 a month extra | Not mentioned on the pages loaded | Snapshots and a backup system included |
| OVHcloud | VPS-1: 2 / 4 GB / 40 GB NVMe | "From" USD 4.54 a month with a 12-month upfront commitment; India site "From ₹420 ex. GST/month" | Many locations; the pages loaded did not list VPS cities clearly. Check US, EU and Mumbai in the configurator | Not mentioned on the pages loaded | Daily backup of the previous 24 hours included; premium automatic backup (7-day rolling) from USD 1.40 a month; snapshots from USD 0.40 a month (US site) |
| Contabo | Cloud VPS 4: 4 / 8 GB / 100 GB SSD (smallest plan sold) | EUR 5.50 a month, "the effective monthly rate for a 24-month subscription including applicable taxes"; the 1-month price was not shown on the page loaded | US: New York, Seattle, St. Louis. EU: Germany (and UK). India: yes. Region surcharges were not shown | Yes (cloud-init for Linux) | Auto Backup as a paid add-on; 1 to 3 snapshots included by tier |
| Scaleway | BASIC2-A2C-4G: 2 / 4 GB (DEV1-M is 3 / 4 GB) | EUR 0.023 an hour, about EUR 16.79 a month (DEV1-M about EUR 14.74); "prices before tax"; disk and public IPv4 billed separately | US: no. EU: Paris shown. India: no | Yes, Scaleway documents "Use cloud-init" for Instances (the guide's text did not load) | Not shown on the pricing page loaded |
| DigitalOcean | Basic Droplet: 2 / 4 GB / 80 GB SSD | USD 24.00 a month; taxes added in some countries | US: New York, San Francisco, Atlanta, Richmond, Kansas City. EU: Amsterdam, London, Frankfurt. India: Bangalore | Yes ("Startup scripts" / user data) | Backups 20% (weekly) or 30% (daily) of the Droplet price; snapshots USD 0.06 per GB a month |
| Vultr | Cloud Compute (regular): 2 / 4 GB / 80 GB | USD 20.00 a month | US: many (New York area, Chicago, Dallas, Seattle, Los Angeles, Atlanta, Silicon Valley, Miami). EU: Amsterdam, London, Frankfurt, Paris, Warsaw, Madrid, Stockholm, Manchester. India: Mumbai, Bangalore | Yes ("Enable Cloud-Init User-Data") | Automatic backups add 20% to the price; snapshots USD 0.05 per GB a month |
| Akamai (Linode) | Linode 4 GB (shared CPU): 2 / 4 GB / 80 GB | USD 24.00 a month, same in North America, Europe and Asia-Pacific (Jakarta and São Paulo have their own prices); taxes collected where they apply | US: yes. EU: Amsterdam, Frankfurt, London, Madrid, Milan, Paris, Stockholm. India: Mumbai, Chennai | Yes (Metadata service, all regions, on images with cloud-init) | Backups USD 5.00 a month for this plan |
| Hostinger | KVM 2: 2 / 8 GB / 100 GB NVMe (KVM 1 has only 1 vCPU) | USD 8.99 a month on a 2-year plan paid up front, renews at USD 14.99; India site ₹799 a month, renews at ₹1,199 | "North America, Europe, Asia, and South America"; the pages loaded did not name cities, so check India and US at checkout | Not found on the pages loaded | Free weekly backups and manual snapshots |
| IONOS | VPS M+: 2 / 4 GB / 120 GB NVMe | USD 5 a month for the first 3 months with a 1-year term, then USD 14 a month; no setup fee; "State and local sales taxes may apply" | US: yes. EU: Germany, Spain (and UK). India: no | Not mentioned on the page loaded | Cloud Backup USD 0.065 per GB a month |

No other cheaper provider was added: web search was not available for this research, and every figure here had to
come from a page that loaded.

### One honest caution each

- **Hetzner Cloud:** excellent value in Europe, but its US plans cost several times more than the EU ones, there is no
  India region, and its terms say "We may, at our sole discretion, choose not to accept any orders". The static page
  also marked plans "not available" until its script ran, so check stock in the console.
- **Netcup:** good value with snapshots included, but the cheapest rate needs a 24-month term, US and some other
  locations cost extra, and traffic is slowed to 200 Mbps if the 24-hour average passes 2 TB. No cloud-init on the
  pages loaded, so plan on running `install.sh` over SSH.
- **OVHcloud:** the lowest headline price, but it assumes 12 months paid up front; the no-commitment price was not
  shown, and cloud-init was not mentioned, so plan on `install.sh`.
- **Contabo:** the most RAM and disk for the money and it has India and US regions, but the advertised rate assumes
  24 months and the page did not show the 1-month price or region surcharges. Read the total on the order form.
- **Scaleway:** EU only, and the list price leaves out the disk and the IPv4 address, so the bill is higher than the
  headline.
- **DigitalOcean:** clear pricing and good guides, but it costs more than the budget hosts. Indian cards must be
  enabled for international transactions, and virtual, electron and prepaid cards are not accepted.
- **Vultr:** good price with US, EU and two India regions, but its payment-methods and FAQ pages did not load for
  this research (the pricing page was read directly), so check how you can pay before relying on it.
- **Akamai (Linode):** reliable and simple, and backups are a flat price, but it costs more than Vultr for the same
  size. Its payment-methods page did not load for this research.
- **Hostinger:** cheap for 8 GB, but only when you pay 2 years up front, and the renewal price is much higher. The
  pages loaded did not show cloud-init or name data-centre cities.
- **IONOS:** the intro price lasts 3 months; plan on the regular price. No cloud-init on the page loaded and no India
  region.

### Sign-up checks and payment (what the pages said)

- **DigitalOcean:** cards, PayPal, Google Pay, Apple Pay, crypto wallets and bank accounts. PayPal needs a USD 5
  authorization charge; cards may get a preauthorization request; no virtual, electron or prepaid cards. Indian
  cards must be enabled for international transactions, and the page lists Indian banks whose cards are "less likely
  to be declined".
- **Contabo:** pays in EUR, USD or GBP; for any method other than a credit card, the first payment after ordering is
  made by hand.
- **Hetzner:** its terms leave the terms of payment and accepting an order to Hetzner's discretion. Its
  payment-methods and verification help pages did not load (404), so expect that a new account may be asked for
  more proof before it can order.
- **Netcup, OVHcloud, Vultr, Akamai, Hostinger, IONOS, Scaleway:** the payment and verification pages tried did not
  load or did not say. Check at sign-up. A credit card in the owner's or business's name is the safest choice
  everywhere.

### Ranking by value for a business of up to 50 people

Value here means: the real monthly cost at the size the suite needs, a region near the users, user data at creation
(the few-clicks path), and backups. Rankings are a judgement from the figures above, not a measurement.

**Owners in the US**

1. **Vultr** — the lowest month-to-month price among hosts with US regions and user data, with backups for 20% more.
2. **DigitalOcean** — a little dearer, but clear pricing, US regions, user data and the best-documented payment rules.
3. **Akamai (Linode)** — same price as DigitalOcean with a flat backup price; a solid alternative.
4. **Hetzner Cloud (servers in Europe)** — the cheapest server with user data if the team accepts a server across
   the Atlantic; skip Hetzner's US plans, which cost far more.
5. **Contabo** — the most server for the money with US regions and user data, but long terms and unshown surcharges.
6. **OVHcloud** — the lowest headline price, but 12 months up front and no user data on the pages loaded.
7. **Netcup** — good value, but the US location costs extra, terms are long and there is no user data on the pages.
8. **IONOS** — fine after the intro price ends, but no user data on the page and dearer than Vultr.
9. **Hostinger** — cheap only on a 2-year prepayment, and it renews much higher.
10. **Scaleway** — no US region.

**Owners in India**

1. **Vultr** — Mumbai and Bangalore, the lowest month-to-month price, user data at creation.
2. **DigitalOcean** — Bangalore, user data, and the only page that explains how Indian cards are handled.
3. **Akamai (Linode)** — Mumbai and Chennai at the same price as elsewhere, with user data.
4. **Contabo** — an India region and user data at a low price, if a long term suits you; read the order total.
5. **OVHcloud** — a low price in rupees ex. GST, but 12 months up front; check that a Mumbai VPS is offered.
6. **Hostinger** — rupee pricing, but a 2-year prepayment, a higher renewal and no India city named on the pages.
7. **Hetzner Cloud (servers in Europe)** — very cheap with user data, but far from India; check data-location rules
   first.
8. **Netcup, Scaleway, IONOS** — no India region.

### Sources (all opened on 2026-10-07)

- Hetzner — Cloud overview — https://www.hetzner.com/cloud — 2026-10-07
- Hetzner — Cost-Optimized plans — https://www.hetzner.com/cloud/cost-optimized — 2026-10-07
- Hetzner — Regular Performance plans — https://www.hetzner.com/cloud/regular-performance — 2026-10-07
- Hetzner — prices behind those pages (the price service their pages call), products CLOUD_132 (CX23), CLOUD_111
  (CAX11), CLOUD_123 (CPX21, US), CLOUD_124 (CPX22), CLOUD_21 (IPv4), CLOUD_24 (snapshots) —
  https://website-price-api.hetzner.com/api/v1/products/CLOUD_132 — 2026-10-07
- Hetzner — Creating a server (cloud-init) — https://docs.hetzner.com/cloud/servers/getting-started/creating-a-server/ — 2026-10-07
- Hetzner — Terms and conditions — https://www.hetzner.com/legal/terms-and-conditions/ — 2026-10-07
- Netcup — VPS — https://www.netcup.com/en/server/vps — 2026-10-07
- Netcup — VPS 500 G12.5 — https://www.netcup.com/en/server/vps/vps-500-g12-iv-12m — 2026-10-07
- OVHcloud — VPS — https://www.ovhcloud.com/en/vps/ — 2026-10-07
- OVHcloud — VPS compare — https://www.ovhcloud.com/en/vps/compare/ — 2026-10-07
- OVHcloud US — VPS — https://us.ovhcloud.com/vps/ — 2026-10-07
- OVHcloud India — VPS — https://www.ovhcloud.com/en-in/vps/ — 2026-10-07
- OVHcloud — Getting started with a VPS — https://docs.ovhcloud.com/en/guides/bare-metal-cloud/virtual-private-servers/starting-with-a-vps — 2026-10-07
- Contabo — VPS — https://contabo.com/en/vps/ — 2026-10-07
- Contabo — Locations — https://contabo.com/en/locations/ — 2026-10-07
- Scaleway — Virtual Instances pricing — https://www.scaleway.com/en/pricing/virtual-instances/ — 2026-10-07
- Scaleway — Instances documentation (lists "Use cloud-init") — https://www.scaleway.com/en/docs/instances/how-to/use-boot-modes/ — 2026-10-07
- DigitalOcean — Droplet pricing — https://www.digitalocean.com/pricing/droplets — 2026-10-07
- DigitalOcean — Droplets — https://www.digitalocean.com/products/droplets — 2026-10-07
- DigitalOcean — Provide user data — https://docs.digitalocean.com/products/droplets/how-to/provide-user-data/ — 2026-10-07
- DigitalOcean — Billing — https://docs.digitalocean.com/platform/billing/ — 2026-10-07
- DigitalOcean — Manage payment methods — https://docs.digitalocean.com/platform/billing/manage-payment-methods/ — 2026-10-07
- Vultr — Pricing (read directly; the fetch tool was refused) — https://www.vultr.com/pricing/ — 2026-10-07
- Vultr — public plans list — https://api.vultr.com/v2/plans?type=vc2 — 2026-10-07
- Vultr — Deploy a server with cloud-init user data — https://docs.vultr.com/how-to-deploy-a-vultr-server-with-cloudinit-userdata — 2026-10-07
- Akamai — Cloud pricing, North America — https://www.akamai.com/cloud/pricing/north-america — 2026-10-07
- Akamai — Cloud pricing, Europe — https://www.akamai.com/cloud/pricing/europe — 2026-10-07
- Akamai — Cloud pricing, Asia-Pacific — https://www.akamai.com/cloud/pricing/asia-pacific — 2026-10-07
- Akamai — Overview of the Metadata service — https://techdocs.akamai.com/cloud-computing/docs/overview-of-the-metadata-service — 2026-10-07
- Hostinger — VPS hosting — https://www.hostinger.com/vps-hosting — 2026-10-07
- Hostinger India — VPS hosting — https://www.hostinger.com/in/vps-hosting — 2026-10-07
- IONOS — VPS — https://www.ionos.com/servers/vps — 2026-10-07

Pages that did not load (404 or refused) on 2026-10-07: Hetzner payment and verification help pages, Vultr FAQ,
Akamai payment-methods page, Netcup FAQ, Hostinger payment-methods and data-centre pages, OVHcloud VPS-1 product
page.
