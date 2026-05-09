# Kairn Ruby/Rails Adapter Future

Ruby is intentionally a future adapter target, not a current headline path.

Kairn's universal retrieval can index `.rb` files through inventory, lexical terms, file summaries, and path/source routing. That is enough for basic Ruby source discovery, but Rails quality needs deeper convention-aware logic before it should be used for product claims.

## Why Defer Ruby

Rails relevance is often implicit:

- autoload paths map constants to files without explicit imports,
- callbacks, concerns, validators, controllers, models, and routes interact by convention,
- `ActiveSupport` indirection makes broad lexical matches noisy,
- tests often live in parallel trees and can dominate exact terms.

Without Rails-aware convention routing, Kairn can find plausible nearby files but still miss the broad base file or framework-level companion needed for a real fix.

## Future Adapter Scope

A Ruby/Rails adapter should add:

- class/module constant extraction,
- Rails autoload path mapping,
- model/controller/route/callback/validation role pairing,
- concern/include/prepend relationship extraction,
- test association for `test/`, `spec/`, and engine paths,
- source-over-noise rules for `guides/`, generated files, dummy apps, and fixtures.

## Current Product Priority

Keep improving the stronger near-term paths first:

- JS/TS framework routing,
- Python package/framework routing,
- Java package/class/method routing,
- Go package/router/middleware routing.

Ruby remains documented so the system architecture stays honest: universal retrieval should work everywhere, but deep language/framework wins should be adapter-backed.
