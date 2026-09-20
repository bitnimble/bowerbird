Ever get back from a holiday with thousands of photos that you need to triage and edit, so you tell yourself "I'll get around to it someday..." and never do?

Bowerbird is a free, fast, intuitive RAW photo triage tool that has light editing capabilities.

## stability
Bowerbird is _not_ currently stable. That being said, there are different "levels" of stability, so maybe its current state is good enough for you.

| Level              | Description                                                                                                                                                       | Is it stable?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data-stable        | Your photos on disk are safe.                                                                                                                                     | Yes. Bowerbird has extremely limited write capabilities to your photo folder. It never deletes files, it only ever moves them. Bowerbird can also run entirely in read-only mode, where it works fine when it doesn't have write access to your photos folder.                                                                                                                                                                                                                                                                                                                                                                                  |
| Catalogue-stable   | Your Bowerbird catalogue (your photo libraries and settings, picks/rejects, edits, stacks, albums, etc - everything that isn't your photo files on disk) is safe. | No. I am still actively changing the database/catalogue schema, and at this time, it's far easier to move quickly if I don't have to care about backwards compatibility. While I will try my best to do migrations properly, at this point in time I would not say there is "zero risk" that in a future update, you'll have to reset and re-import your photo library into Bowerbird again. That may not be an issue for you, because that would only be a chance on a Bowerbird update. If you are working through a catalogue that you're going to get done before the next update you care about, then this is not an issue for you. |
| Renderer-stable    | Your Bowerbird edits will look the same after a Bowerbird update.                                                                                                 | No. I am actively changing the rendering pipeline, so it's highly _likely_ (not just possible) that on a Bowerbird update, existing edits to photos may look slightly different compared to when you first made those edits. That being said I'm changing the renderer largely to fix bugs and improve quality, so if anything it should look _better_, but it's worth pointing out because any difference may be surprising. At some point, after a stable release, the renderer will be locked in and there will be some guarantee of renders looking the same. If this does not bother you, then you can ignore this row.     |
| Application-stable | Bowerbird does not crash.                                                                                                                                         | If anybody guarantees this to you about any software, they're lying                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Device-stable      | Bowerbird operates consistently and reliably on all devices                                                                                                       | I can only test on the devices I have and actively use. These are: a Windows PC, a Macbook Pro with M5 Pro, and a Samsung Galaxy Fold 7. Outside of that, I can only fix what's reported to me.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## features
- Insanely fast import speeds, around 50 photos per second off a spinning hard drive or SD card. Import means, from nothing, to "this photo exists in the catalogue, I can see it in the photo grid, it has a thumbnail, and I can open it in the viewer or editor at full resolution, instantly".
- Insanely fast viewing speeds. If you press "next photo", the next photo will render within a single frame. When viewing photos, you are never waiting on the software.
- HDR-first workflows - HDR is most important during the triage phase, because it lets you immediately see the exposure headroom in a RAW without needing to edit it. Bowerbird supports automatic fast prerendering of RAWs as HDR renditions, allowing you to instantly view all photos in HDR after import. While HDR viewing allows you to see clipped highlights, the more useful situation is being able to see clipped colours, which are fully saturated in HDR but clipped to white (completely desaturated) in a regular JPEG. If you take a lot of night photography, especially urban, this will be extremely useful to you. 
- Colour matching - Bowerbird can accurately generate colour profiles to match the camera body's rendition. If you like your camera's colour rendering, or you prefer to use your camera's colour profiles (especially if you switch them on the fly), you no longer need to reproduce the colour profiles in your RAW editor. Bowerbird matches colours automatically during RAW renders by default.
- Lens distortion matching - similarly, Bowerbird will figure out the distortion correction profiles for your lenses automatically, even without a lens profile. (External lens profiles can still be manually loaded where necessary)
- Run it on your NAS, and keep all files on your bulk storage.
	- View/triage/edit photos remotely over a web UI. All of your photos stay on your NAS, and everything in the web UI is snappy. This is actually the default way of using Bowerbird, and what I largely use to test.
	- Also run the full app on your travel laptop - Bowerbird will keep both libraries in sync when you want them to. Import and edit photos while you're on a trip, then get home and click sync to back everything up to your NAS. You can even do multi-way sync between more devices, if you want.
- Automatic photo stacks - groups similar photos together, e.g. a burst sequence, or multiple shots of the same scene. It's resilient to changes in exposure, focus, composition, and orientation.
- King-of-the-hill triaging for photo stacks - have you ever tried triaging a 15-shot burst sequence of the same scene and thought to yourself "surely there is a better way to compare all 15 photos against each other instead of just flicking between them all"? Bowerbird sets up photos in pairwise comparisons, to make it easy for you to get through a stack of photos and pick the best ones. It's similar to the system used by optometrists when testing whether lens A or lens B is sharper.
- Photo merging:
	- Extremely fast panorama merging. Stitch together 20 RAWs in seconds!
	- Take best parts of multiple photos - got a group photo where one photo is almost perfect but someone was blinking? Bowerbird can help you composite their headshot from a similar frame, seamlessly. Similarly, use this tool to remove unwanted objects from a scene if you have another similar photo at a different time.
- Automatic dust and spot removal at small apertures
	- It also aggregates across multiple frames in your library to reduce false positives. This makes it very accurate, so it's enabled by default. You can pretty much just ignore the fact that you have a filthy sensor that you really have to clean but haven't gotten around to it yet... yeah maybe i should remove this feature for now...
- Sane organisational structures - Bowerbird supports both "shoots" (real folders on disk, a photo can be in only one shoot), as well as "albums" (arbitrary collections, a photo can be in multiple albums). You can choose however you want to organise them.
- Read-only mode - if you don't trust Bowerbird with your data, you can run it in full read-only mode. It does not need write access to your photos folder at all, so it literally cannot move or delete anything. You can still use ~95% of the features of Bowerbird in this mode.
- Full GPU acceleration - everything is GPU accelerated. Everything is also WebGPU compatible, so if you have any somewhat modern device, you can use every feature in a web browser (yes, including RAW editing, even on a mobile phone!)
- Cross platform compatibility - Bowerbird lets you view, triage and edit from pretty much any device - Mac, Linux, Windows, iPhone, Android. If it has a recent web browser (other than Firefox*) and has any graphics engine at all, you can do everything. If you only need to view and triage but not edit, then literally anything with a browser that can show a JPEG will work - your TV, Nintendo 3DS, your Apple watch, your Samsung fridge (probably).
## coming soon
 - Don't want to / can't run a Docker container on your NAS? No problem, just run Bowerbird entirely on your client device and then automatically back up content to any SMB share seamlessly. Recent content and actively edited photos are kept local for performance. Basically the whole "copy to SSD first to triage, then copy to NAS manually afterwards" flow, but automatic.
 - ML models for denoise, sharpen, inpainting, etc. At the moment, Bowerbird only contains (very good) deterministic denoisers and sharpeners. These are pretty good, but ML-based models achieve significantly better detail recovery, objectively speaking, but they cost performance, which is why this work has been deferred for now.
 - Actually good soft proofing - not once have I seen a soft proof for print that actually looks anywhere near the print. Bowerbird will have a 3D rendered scene with accurate soft proofing, that will allow you to actually see what your print looks like as you move it around and see it in different lighting.
 - Custom colour mapping and editing
 - Smart colour grading - editing profiles that achieve a target look, rather than a specific set of edits. Use this to achieve consistency across multiple shots that had varying exposure, colour temperature, shading, tint, blurriness, etc. Or just chuck it onto your entire shoot, up to you.
 - Better support for Fujifilm / X-Trans sensors. These are supported right now, but barely tested, and I'm sure there are a lot of improvements needed.
 - Scheduled Instagram posts - 95% of my edited photos go into Instagram, so why not make this easier
 - Photo merging
	 - Exposure and focus bracket merging
	 - Pixel shift x4 and x16 for Sony cameras
 - Collaborative triaging and editing - see other people work on the same library at the same time. Almost none of my trips are solo, I'm always with my partner, family, or friends - being able to triage together (online) makes it more motivating and engaging.

## requirements
 - For viewing, you only need a web browser (or install the app)
 - For rendering or editing, you need a device that has a GPU. This can be an integrated GPU.
	 - If you run the Docker container, this server-hosted version of Bowerbird does some rendering work, so it needs a GPU.
	 - If you edit photos, this uses the GPU on your client device.
	 - Technically, this means you can edit on a mobile device (every modern phone has integrated graphics), and it does work, although stability is not guaranteed, especially with higher resolution RAWs.
 - You need about 2-4GB of system memory, and 2-4GB of VRAM. This multiplies by however many parallel workers you want Bowerbird to run.

## who is this for?
I want to be really clear about this - this software is for _me_. I built this originally intending it to only be for myself. After showing some friends and talking about it, I decided that it would be nice to share it openly, but with no restrictions or responsibility.

Even though this is open source, I don't intend on accepting many PRs, taking feature requests (yet) etc - ultimately I am still building this for myself and my own workflow. Feel free to fork, modify, redistribute as you wish. This repo is MIT licensed out of habit but tbh unless you are a mega corp like Adobe, I don't really care what you do with the code and whether you credit me or not.

With that out of the way... this software is designed for people who:
- take a lot of photos in a "session", E.g. let's say 1000 photos taken
- choose only some of them (let's say 10-30%, or 100-300 photos) to keep. to do so, you need to actually look at all of the photos you took.
- lightly edit most of them (let's say out of 300 photos, you adjust 80% of them). a "light edit" here is:
	- something you spend < 2 minutes on, per photo
	- probably a combination of exposure/light correction, colour correction, denoise, sharpen, and geometry (straighten, keystone, or crop)
	- maybe some small dust and spot removal
	- usually global edits only. no masks or local adjustments
- you heavily edit only a handful of photos, maybe 10 or so, to keep in a "favorites" album or something.
	- you pore over every detail on these photos
	- you take care and do local masking and adjustments, colour mapping, tone curves

This could be a few different photographer personas:
- A casual photographer who took 1000 photos on a holiday, where a lot of them are just bad (me)
- An event photographer who took 1000 photos at an expo
- A wedding photographer team who took 1000 photos on wedding day
- A portrait photographer who took 1000 photos during a shoot
- A sports photographer who took (probably a lot more than) 1000 photos during a meet
- A bird photographer who took 1000 pictures of that one bird at the wildlife park (also me)
These are all fairly high input volume workflows. The nature of these personas is to capture as much as possible at the time of shooting, because it's difficult or impossible to "take your time" during the shoot, so you reduce risk by spamming photos and triaging later. I used 1000 photos as a nice round number here, but many of my trips have 2000, 3000, 5000 photos, and I'm sure there are people who take way more than me as well.

If you are the type of person that:
- Takes care with your shots in the same way that you used to shoot on film cameras
- Takes street photography with intent
- Uses a tripod for all your shots, e.g. a landscape photographer
- Needs the full editing power of a more mature RAW processor
- Needs to have guaranteed perfect compatibility when you reopen an editing session in 10 years time
Then you're probably not the ideal user. Bowerbird does offer some great utility still, and it's free to use if you want try, but I don't know if you'll get that much value out of what Bowerbird is intending to do.

## why?
I built Bowerbird because every single RAW catalogue tool was extremely slow. 

Pretty much none of them seemed designed around the workflow that I suspect a lot of casual and travel photographers have (see above). The vast, vast majority of my time spent "editing" photos is actually just spent _looking at thousands of pictures_. If it takes my editing software multiple seconds to show me the next photo when I click "next", that could literally be hours of my time wasted just waiting for the software to load my images (which it should have already imported and processed!).

Because I like to keep photos on my NAS, it's even worse - either I edit directly off the NAS which is even slower, or I import to my computer's SSD first, triage and edit, then copy to my NAS manually after that.

I also had a lot of product ideas that would make triaging and editing photos much faster and simpler, which I don't really know why they don't exist in other major software (to my knowledge).

Bowerbird's goal is simple: every second you actively spend at the computer triaging and editing photos is valuable, so make it as fast as possible. That also means not cutting corners on quality where necessary, because if something isn't clear enough for you to see, that's also a waste of your time in a different way. If you are using Bowerbird, then you are actively thinking and using the software the entire time.

>This project has been in my backlog for a very long time; after multiple trips overseas this year and a huge backlog of photos to get through, as well as Claude being Claude, I decided to procrastinate editing my photos even more and instead start work on this project as an excuse, because after I finish this I'll finally be able to triage my photos, right??

## is Bowerbird free?
Yes, and it always will be. Bowerbird will never have a paid "pro" mode, never have ads, and all desktop, mobile, and self-hosted functionality will always be 100% free.

The only possible monetisation I might do in future is "automatic end-to-end encrypted cloud storage and backup", which is optional and only if you want to use it for the convenience. It will be extremely fairly priced based on what it would cost me for storage + egress, and a small margin. This might be on the order of magnitude of a $10 USD/mo for 1TB. On a modern camera with compressed RAWs of about 50MB, 1TB stores 20,000 photos.
I would be using this for my own family, for people like my parents and relatives who will never be setting up their own self-hosted Docker container.
This would also be open source and in this repo, and nothing would prevent you from running it yourself at wholesale pricing from your favourite blob storage provider.

## ew, vibe coded junk
Yeah well, this product wouldn't exist without Claude, so if you prefer to live in a universe where LLMs didn't exist, then you can just pretend that this page doesn't exist either. That being said, I can confidently say that while this is very much vibe coded, it isn't vibe engineered - every major technical design decision, every product feature, etc have all been intentfully designed by this meat sack right here. While I definitely don't have full vision over the code level anymore (and definitely need to audit some parts again), if you see dodgy shit in the product then you can almost certainly blame me for it, not Claude.

I've had this entire product vision in my head for a very long time, probably 5 to 10 years or so. Even back then I already had thoughts of "why the f is this so slow?" when using (various other industry leading competitors). Unfortunately, as life is, I never had the time to actually build it properly, so it sat in the backlog until this year. 
Well thankfully with the power of two Claude Max 20x plans, it turns out I can build a fairly usable product in my spare time now. I'd say that in the span of ~2 months, I've built enough product that would otherwise have taken myself multiple years full-time to build. At my previous salary, or if I had made this a company and hired an engineer (with the necessary experience) to work on it, that would probably have cost somewhere between $1-2 million AUD. Instead, it cost me probably about 50-100B tokens, or about $40k-$85k AUD in API token pricing. Since I pay for two subscription plans, I actually paid only $600/mo, or $1200 AUD total. I like to think that I'm milking Anthropic's investors as hard as possible. 

None of this readme was written by an LLM, by the way. I typed all of this with my little human fingers.

## who are you?
Just some guy who once worked at a small company called Canva for a while

## what does the name mean?
Nothing special, I just like birds, and bowerbirds are native Australian birds that are notable for collecting/arranging bright and shiny things. 