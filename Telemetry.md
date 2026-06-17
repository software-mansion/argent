# Argent Privacy Notice (Telemetry)

Effective date: 16 June 2026 · Version: 1.0

This notice is a product-specific supplement to the Software Mansion Privacy Policy (the "Policy") and applies to telemetry collected by Argent, a Software Mansion Software Product. Capitalised terms used but not defined here (including Personal Data, Usage Data, Legitimate Interest, EEA and Software Mansion Software Product) have the meaning given to them in the Policy. Where this notice and the Policy differ in respect of Argent telemetry, this notice prevails.

Argent collects a small amount of usage and diagnostic data ("telemetry") to help us understand how the tool is used and to make it more reliable. We have designed it to be minimal by default: we do not collect the content of your work - no source code, no file paths, no tool inputs, no application data, no error messages, and no device identifiers.

## How to opt out

Telemetry is enabled by default. You can disable it at any time, and the change takes effect immediately and permanently for that installation. This is also how you exercise your right to object (see Your rights below).

```bash
argent telemetry disable
```

To check the current status:

```bash
argent telemetry status
```

Disabling telemetry does not affect any functionality of Argent.

## Why we collect telemetry

We use telemetry, in our Legitimate Interest, only to:

- understand which features are used, so we can prioritise development;
- detect where installation, updates, or tools fail, so we can fix them;
- measure reliability and performance (e.g. how long operations run, error rates);
- understand the environments Argent runs in (operating system, runtime versions, terminal vs CI).

We do not use telemetry for advertising, marketing, profiling, automated decision-making, or sale of data, and we never combine it with any account or with Personal Data collected through other Services.

## What we collect

### Installation, update and uninstallation

- the progress of an installation: which options were selected; whether it started, completed, failed, or was cancelled; and at which step it was cancelled;
- the progress of an update to a newer version;
- the progress of an uninstallation of Argent.

### Tool and process usage

- which Argent tools are invoked, and whether they succeeded or returned an error;
- which AI coding tool is driving Argent;
- how long a process ran in the terminal or in CI, and which Argent component emitted the event;
- start and stop of the Argent tool-server, its uptime, the number of tools used, and the reason it stopped.

### Environment

- Argent version, Node.js version, operating system, processor architecture;
- whether the process runs in an interactive terminal and whether it runs in a CI environment;
- whether Argent is used in connection with Android or iOS.

### Diagnostics

- the fact that an error occurred (event type and code only — never the error content or message).

### Identifiers

- a randomly generated identifier that persists for an installation, used only to distinguish unique installations and to de-duplicate events. It does not contain, and is not derived from, your name, username, account, or any device identifier;
- a random session identifier generated for each usage session.

## What we never collect

To be explicit, Argent telemetry never includes:

- tool inputs or arguments;
- file paths or file names;
- source code or its contents;
- application data;
- device identifiers (e.g. hardware IDs, MAC addresses, serial numbers);
- the content or text of error messages.

## Who we disclose the data to

We use PostHog (provided by PostHog, Inc., San Francisco, USA) as our product analytics provider, acting as our processor under a Data Processing Agreement.

Telemetry data is hosted in the European Union (Frankfurt, Germany) on PostHog's EU Cloud. PostHog engages its own sub-processors (cloud hosting and operational monitoring) located in the EU for the EU Cloud and keeps this list to a strict minimum. You can find the current list of PostHog sub-processors on PostHog's website, and a set of useful links is available from us on request.

## Legal basis for processing

The controller is Software Mansion S.A. (details below). To the extent that the telemetry described here constitutes Personal Data, we process it on the basis of our Legitimate Interest (Article 6(1)(f) GDPR) in maintaining, securing, and improving Argent, consistent with the legitimate-interest grounds set out in the Policy. We have carried out a balancing assessment, taking into account the minimal and non-content nature of the data and the simple opt-out above, and concluded that this interest is not overridden by your interests or fundamental rights and freedoms. You may object to this processing at any time by opting out.

## How long we keep the data

Telemetry events are retained for up to 72 months, after which they are deleted or aggregated into non-identifiable statistics.

## International data transfers

Telemetry data is stored within the EEA (Germany). As PostHog, Inc. is established in the United States, access from outside the EEA (e.g. for support) may occur and is governed by the European Commission's Standard Contractual Clauses.

## Your rights

Subject to the conditions in the GDPR, you have the right of access, rectification, erasure, restriction of processing, data portability, and the right to object, as described in the Data Subject Rights section of the Policy. Because the data is not linked to a named individual or account, we may be unable to identify your specific records without additional information from you (Article 11 GDPR); the most effective way to stop processing is to opt out as described above.

To exercise these rights, contact us at legal@swmansion.com.

You also have the right to lodge a complaint with a competent supervisory authority. In Poland this is the Personal Data Protection Office (UODO), ul. Stawki 2, 00-193 Warszawa.

## Controller and contact

The controller of your Personal Data is Software Mansion S.A., a joint stock company with its principal place of business at ul. Zabłocie 43b, 30-701 Kraków, Poland, entered in the register of businesses conducted by the District Court in Kraków for Kraków-Śródmieście, XI Commercial Division of the National Court Register with KRS number 0000961952, NIP 6793131302, REGON 364909814.

For any questions or requests regarding this notice, contact us at legal@swmansion.com.

## Changes to this notice

We may update this notice as Argent evolves. The most current version will be available with the effective date and version shown at the top, and material changes will be announced through the usual Argent release channels.
