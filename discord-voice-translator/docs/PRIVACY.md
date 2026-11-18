# Privacy and data

This page describes what VocaLink does with voice and text in the cloud pipeline. It is a technical description, not legal advice.

## What is processed

| Data | Sent to | Stored by VocaLink |
|---|---|---|
| Speech audio of people in the call | Soniox, for recognition and translation | No. Audio is never written to disk. |
| Translated text | ElevenLabs, to be spoken | No, apart from captions posted in Discord. |
| Captions (original and translations) | Discord, in a thread | Kept in Discord like any message. |
| Settings and preferences (languages, volume, voice choice, opt-out) | Nobody | Yes, in the bot's database. |

Usage statistics are kept without any text: language, timing and counts only.

## People who do not want to be translated

Anyone can run `/optout`. Their audio is then ignored before it is decoded, in every server, and nothing they say is sent to Soniox or ElevenLabs. `/optin` undoes it.

When the bot starts in a channel it posts a notice saying that voices are processed live and never recorded.

## Using your own voice

A speaker can choose **My own voice** in the personal translator panel. That choice is their consent, and nobody can make it for them.

- VocaLink then keeps about 45 seconds of that person's clear speech in memory, sends it once to ElevenLabs to create the voice, and discards it.
- Speech held for learning is dropped if they leave the call or change their mind.
- **Delete my voice**, or `/optout`, deletes the voice at ElevenLabs straight away. If they withdraw while the voice is still being created, it is deleted as soon as it exists.

## Third parties

Soniox and ElevenLabs process audio and text under their own terms. If you run VocaLink publicly, name them in your privacy policy and set `PRIVACY_URL` so the link appears in the start notice.
