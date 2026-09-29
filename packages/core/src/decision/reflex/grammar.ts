/**
 * Patterns that multiply into thousands more phrasings, to train Reflex's classifier. They
 * aren't matched directly: so many near-copies would crowd the closest-example search.
 * `[a|b|]` picks one option (empty is allowed), `$name` is a shared list below, and
 * {app}, {agent} and {project} stay placeholders. Never copy a phrasing from the evaluation sets.
 */

const LISTS: Record<string, string> = {
  pre: '[|can you|could you|would you|please|nova|hey nova|okay|um|uh|so|hey|go ahead and|i want you to|quickly|right|alright|kindly|please can you]',
  post: '[|please|for me|now|right now|real quick|quickly|thanks|for me please|if you can|when you can]',
  lead: '[|can you|could you|please|nova|okay|um|go ahead and]',
  ask: '[|hey|nova|hey nova|okay|um|so|excuse me|please|sorry|quick question]',
  dur: '[5 minutes|five minutes|10 minutes|ten minutes|two minutes|2 minutes|one minute|a minute|30 seconds|thirty seconds|an hour|half an hour|an hour and a half|90 seconds|45 minutes|fifteen minutes|25 minutes|three minutes|two hours|twenty minutes|forty seconds|seven minutes|twelve minutes|1 hour]',
  dur1: '[5 minute|five minute|10 minute|ten minute|two minute|15 minute|20 minute|30 second|one hour|half hour|45 minute|90 second|3 minute|twenty five minute|one minute|forty minute]',
  task: '[fix the failing tests|fix the build|add a readme|write unit tests|refactor the auth module|update the dependencies|clean up the code|add dark mode|fix the login bug|write the documentation|add logging|set up ci|add a new endpoint|optimize the queries|rename the components|remove the dead code|add error handling|fix the type errors|upgrade react|add pagination|write a migration|fix the css|make the page responsive|add a search bar|review the code|commit the changes|open a pull request|bump the version|fix the linter warnings|add input validation|write an api client|build the settings page|add caching|fix the memory leak|set up docker|add tests for the parser|translate the strings|fix the flaky test|update the changelog|split up the big file]',
  where: '[|in {project}|on {project}|for {project}]',
  topic: '[machine learning|a black hole|inflation|photosynthesis|the stock market|a neural network|climate change|the roman empire|the french revolution|quantum physics|blockchain|democracy|gravity|a recession|the internet|dna|vaccines|electricity|the solar system|jazz|stoicism|a mortgage|cryptocurrency|the cold war|evolution|a volcano|an api|cloud computing|the big bang|meditation|a credit score|compound interest|algebra|the immune system|a hurricane|renewable energy|supply and demand|kente cloth|the ashanti empire|the pyramids]',
  howto: '[learn to swim|cook jollof rice|save money|get better sleep|lose weight|learn to code|write a good cv|speak in public|grow tomatoes|fix a flat tyre|clean my laptop screen|back up my phone|make friends in a new city|study for an exam|become a better writer|start investing|negotiate my rent|train my dog|get a visa|improve my english|focus better|make pancakes|change my wifi password|take better photos|remove a virus from my laptop|learn the guitar|prepare for an interview|deal with anxiety|plan a wedding|make kelewele]',
  country: '[france|ghana|nigeria|kenya|japan|brazil|canada|egypt|india|germany|south africa|australia|mexico|italy|china|togo|senegal|spain]',
  person: '[mum|dad|mummy|daddy|honey|babe|guys|kids|bro|sis|auntie|uncle|dear|sweetie]',
  when: '[at 5|at 6 pm|at 7 in the morning|at noon|at half past four|at 9:30|tomorrow|tomorrow morning|tomorrow at 9|tonight|this evening|on friday|on monday at 9|next tuesday|on the 12th|by 8|on sunday afternoon|at 3 tomorrow]',
  every: '[every morning|every weekday at 9|every friday|every day at 8|every monday and thursday|on weekdays at 7|every sunday evening|on the 1st of every month|every night at 10]',
  todo: '[call my mum|send the report|pay the rent|take my medicine|water the plants|call kofi|renew my passport|book the flight|pick up the kids|buy bread|charge my phone|check the post|file my hours|stand up and stretch|drink some water|prepare the slides|pay the electricity bill|email the landlord|go for a run|back up my laptop]',
  fact: "[my standup is at ten|my birthday is in may|i prefer short answers|i work from home on fridays|my manager is kofi|my car is blue|the office is on the third floor|i'm vegetarian|i'm allergic to nuts|my flight is on tuesday|the deadline is friday|my gym days are monday and thursday|my wife's name is ama|my son's school starts at eight|the project is called nova|i use a mac for work|i like my coffee black|my dentist is on wednesday|the wifi is called home five|my sister lives in accra]",
  // Nova's hands.
  level: '[10|15|20|25|30|35|40|45|50|60|65|70|75|80|90|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|a hundred|half|max|zero]',
  pos: '[to the left|to the right|on the left|on the right|to the left half|to the right half|in the top left corner|in the top right corner|in the bottom left corner|in the bottom right corner|to the left third|to the right third|in the middle third|in the middle|to the top half|to the bottom half|on the left two thirds|on the right side|on the left side]',
  file: '[resume|cv|passport scan|tax return|lease|contract|invoice|bank statement|boarding pass|budget|essay|thesis|pay slip|receipt|report|presentation|meeting notes|wedding photos|insurance letter|school fees receipt|project proposal|quote from the plumber|visa application]',
  folder: '[documents|my documents|the desktop|my desktop|downloads|the taxes folder|the receipts folder|the work folder|pictures|the school folder|the archive folder|icloud drive]',
  music: '[some jazz|some gospel|some afrobeats|highlife|some lo-fi|my workout playlist|my liked songs|something upbeat|something calm|some classical music|burna boy|beyonce|the weeknd|sade|bob marley|my chill playlist|some hip hop|country music|amapiano|some reggae|the new album|my discover weekly|kuami eugene|adele]',
  shortcut: '[log water|morning|evening|commute|focus|timesheet|lights off|home|log weight|translate|workout|meditation|expenses|standup|podcast|send eta|dim lights|log mood|reading|bedtime]',
  layout: '[work|coding|writing|meetings|focus|design|school|research|streaming|trading|editing]',
  chore: '[book a table for two|order more printer ink|fill in this form|renew my car insurance|pay the electricity bill|sign me up for the newsletter|check in for my flight|buy a birthday card|find a cheap flight to lagos|cancel my gym membership|order groceries|book a doctor appointment|unsubscribe from these emails|apply for the job|update my shipping address|submit my timesheet|request a refund|return the shoes|top up my phone|register for the conference]',
};

/**
 * The individual words used in $pre/$post/$lead/$ask - not phrasings to match, but words that
 * open or close a request without saying anything about it. Used to recognise a held-out eval
 * phrasing's near-copies (the same words plus only these) as leakage too, not just its exact,
 * name-blanked self.
 */
export const FILLER_WORDS: ReadonlySet<string> = new Set(
  (['pre', 'post', 'lead', 'ask'] as const).flatMap((key) =>
    LISTS[key]!
      .slice(1, -1) // the outer [ ]
      .split('|')
      .flatMap((option) => option.trim().split(/\s+/)),
  ).filter(Boolean),
);

export const REFLEX_GRAMMAR: Record<string, string[]> = {
  system_control: [
    '$pre [turn|put|bring|crank|push|knock|drop|pump|nudge] [the volume|the sound|the speakers|the audio|it] [up|down|way up|way down|up a bit|down a bit|up a little|down a little|up a notch|down a notch|up some more|down some more] $post',
    '$pre [set|put|change|bring|make|adjust] [the volume|the sound level|the brightness|the screen brightness|the display brightness] [to|at] $level [|percent|per cent] $post',
    '$pre [make|get] [the sound|the volume|the speakers|the music volume|the mac] [louder|quieter|softer|lower|higher|a bit louder|a bit quieter|a lot louder] $post',
    '$pre [mute|unmute|silence] [the sound|the volume|the mac|the speakers|the computer|the laptop|the audio|all the sound|the system sound] $post',
    '$pre [dim|brighten|darken|lighten] [the screen|the display|my screen|the monitor|the laptop screen] [|a bit|a little|a lot|all the way|right down] $post',
    '$pre [turn|switch|put] [the brightness|the screen brightness|the display] [up|down|right up|right down|all the way up] $post',
    '$pre [turn on|turn off|switch on|switch off|enable|disable|toggle|kill] [dark mode|light mode|night mode|the dark theme|wifi|wi-fi|the wifi|the wireless|bluetooth|the bluetooth|do not disturb|focus mode|the focus] $post',
    '$pre [switch|change|flip|go|move] [to|into|over to|back to] [dark mode|light mode|the dark theme|the light theme|do not disturb|focus mode] $post',
    '$ask [is|are] [my wifi|the wifi|bluetooth|my bluetooth|dark mode|do not disturb|focus] [on|off|switched on|turned on|switched off|enabled] [|right now|at the moment|now]',
    "$ask [how much battery|how much charge|how much juice] [do i have|is left|have i got|is there] [|left|right now|on this laptop]",
    "$ask [what's|what is|how's] [my battery|the battery|the battery level|my battery percentage|the volume|the brightness] [|at|on|now|right now|looking]",
    '$ask [is|is the] [laptop|mac|macbook|computer] [charging|plugged in|on charge] [|right now|now]',
    '$pre [lock|lock up] [the screen|my screen|the mac|my mac|the computer|the laptop|the macbook] [|now|please|for me|right now]',
    '$pre [put|send] [the mac|my mac|the computer|the laptop|the macbook] to sleep [|now|please|for me]',
    "$pre [crank|pump|turn|bump|push] it up [|a bit|a little|a notch|some more] [|i can hardly hear it|it's too quiet|i can't hear a thing|it's way too low]",
    '$pre [switch|change|flip|set|put] the [laptop|mac|computer|screen|display|whole thing] [over to|into|to] [dark|light|night] [mode|appearance|theme|look]',
  ],
  text_size: [
    '$pre [make|get|turn|set|put] [the text|the font|the writing|the words|the letters|the captions|the transcript|your text|your words|the subtitles] [bigger|smaller|larger|a bit bigger|a bit smaller|a lot bigger|a lot smaller|a little bigger|a little smaller|easier to read|more readable|big|small|huge|tiny] $post',
    '$pre [increase|decrease|reduce|enlarge|shrink|bump up|knock down|scale up|scale down|turn up|turn down] [the text size|the font size|the text|the font|the caption size|the size of the text|the size of the words] [|a bit|a little|a lot|a notch] $post',
    '$pre [set|put|change|make] [the text size|the font size|the text|the font] [to|at] [80|90|110|120|125|130|140|150|160|175|180|200|a hundred and fifty|a hundred and twenty] [percent|per cent|%] $post',
    '$pre [reset|restore] [the text size|the font size|the text|the font] [|to normal|to the default|back to normal] $post',
    '$pre [make|put|set] [the text|the font|the text size] [back to normal|normal again|the default size|its normal size|the usual size] $post',
    "$ask [the text|the font|the writing|the words|the captions|your text] [is|are|looks|seems] [too small|too big|tiny|hard to read|too large|way too small]",
    "$ask [what's|what is|how big is|what size is] [the text|the font|the text size|the font size] [|right now|at the moment|set to]",
    '[these|the|your] [captions|words|letters|subtitles|text|transcript] [are|is] [really|too|so|a bit] [hard to read|small|tiny|hard to see] [|blow them up|make them bigger|can you make them bigger|make it bigger]',
    '[can|could] [the writing|the text|the words|your text|the transcript] [on your screen|in the window|on the screen|in your window] be [a touch|a bit|a little|much|a lot] [larger|bigger|smaller]',
    '$pre [set the text to|put the text at|make the text|change the text size to|take the text to] $level [percent|per cent] $post',
    '[how big|how large|what size] is the [text|font|writing|transcript text] [set at|at the moment|right now|now|at]',
    "[i need|i want|i'd like] the [letters|words|text|font|writing] [to be|] [much|a lot|a bit|a little] [bigger|larger|smaller]",
  ],
  media_control: [
    '$pre [pause|stop|resume|unpause|restart|continue] [the music|the song|the track|spotify|the podcast|playback|the album|the playlist|the audiobook|what is playing] $post',
    '$pre [skip|skip past|jump past] [this song|this track|this one|the song|the track|ahead] [|please|for me|i hate it|now]',
    '$pre [next|play the next] [song|track|tune] [|please|now|for me]',
    '$pre [go back|back up|jump back] [a song|a track|to the last song|to the previous track|one song|one track] $post',
    '$pre [play|put on|throw on|queue up|shuffle|blast|start playing|play me] $music [|on spotify|in music|please|for me|now|in the background]',
    "$ask [what's|what is|which song is|who's|who is] [playing|this song|this track|singing|singing this|playing right now|on right now] [|right now|now|called|at the moment]",
    '$ask [what song is this|who sings this|what track is this|what am i listening to|name this song] [|please|nova|right now]',
    '[next song|next track|previous song|previous track|skip song|pause music|resume music|play music] [|please|nova|thanks|now]',
    "[who|which artist|what band|who is it that] [sings|is singing|made|plays|performs] [this|this song|this track|that song|the song that's playing|what's playing] [|again|now]",
    '$pre [throw on|stick on|chuck on|bang on|put on|spin] [some|a bit of|a little] [afro house|deep house|afro swing|drill|soca|bongo flava|highlife|afrobeats|house music|techno|jazz|soul] $post',
  ],
  window_control: [
    '$pre [put|move|snap|push|throw|shift|place|send|slide] {app} $pos [|of the screen|please|for me]',
    '$pre [put|move|snap|push|shift|throw] [this window|this|the window|the front window|this app] $pos [|of the screen|please]',
    '$pre [maximize|maximise|centre|center|minimize|minimise|full screen] [this window|the window|{app}|this app|the front window] $post',
    '$pre [make|put] [this window|{app}|this] [full screen|fill the screen|as big as it goes|centred|in the middle of the screen|take up the whole screen] $post',
    '$pre [move|send|throw|push|put] [this window|{app}|this] [to|onto] [the other screen|my other monitor|the second display|the external monitor|the laptop screen|the other display] $post',
    '$pre [put|arrange|tile|split] {app} [and|next to|beside|with] {app} [side by side|next to each other|half and half|left and right|on the screen] $post',
    '{app} [on the left|to the left|left] [and|with] {app} [on the right|to the right|right] [|please]',
    '$pre [save|remember|store|keep] [this layout|my windows|this window layout|this arrangement|the way my windows are] as [|my|the] $layout [|layout|setup] $post',
    '$pre [set up|restore|bring back|load|switch to|give me|put back] my $layout [layout|windows|window layout|setup] $post',
    '$pre [hide|unhide] [{app}|all the other apps|everything but this|the other windows] $post',
    '$pre [exit|leave|get out of|come out of] full screen [|mode|please|now]',
    '$pre [tuck|put|send|drop] [{app}|this window|this] [away in the dock|into the dock|down into the dock|to the dock] $post',
    '$pre [arrange|lay out|set up|organise|organize] [my windows|the windows|my screen|everything] [for|for my|for the] $layout [|work|session|mode|stuff]',
    "$ask [what windows|which windows|what apps] [are open|do i have open|have i got open|are running] [|right now|now|on the screen]",
    '$pre [move|push|send|throw|drag|put|shift] {app} [over to|onto|to|across to] [my|the] [second|other|external|left|right|big|laptop] [monitor|screen|display] $post',
    '$pre [shrink|minimise|minimize|hide|tuck|send|put] {app} [down to|down into|into|to|away in] the dock $post',
    '$pre [lay out|arrange|set up|put back|restore|bring back] my windows [the way i saved for|like my|as my|in my|for] $layout [|layout|setup|arrangement] $post',
  ],
  files: [
    '$pre [find|look for|search for|locate|dig up|track down] [my|the] $file [|file|pdf|document|from last week|from yesterday|from march|i saved|i downloaded] $post',
    '$ask [where is|where did i put|where did i save|where can i find] [my|the] $file [|file|pdf|document|from last week]',
    '$pre [open|pull up|bring up|show me] [my|the] $file [file|pdf|document|spreadsheet|from yesterday|from last week|i was working on] $post',
    "$ask [what did i download|what have i downloaded|what's new in my downloads|what files did i change|which documents did i open|what was i working on] [today|yesterday|this week|lately|recently]",
    '$pre [show|reveal] [the|my] $file in finder $post',
    '$pre [move|put|file|drop|shift] [the|my|this] $file [into|to|in] $folder $post',
    '$pre rename [the|my|this] [screenshot|report|invoice|draft|file|photo|document|pdf] to [final|receipt|march invoice|signed contract|holiday photo|version two|old copy] $post',
    '$pre [trash|bin|delete|throw away|get rid of] [the|that|this|my old] [screenshot|duplicate photo|draft|old invoice|download|zip file|installer|copy of the report|blurry photo] [|on my desktop|in my downloads|from yesterday|file] $post',
    '$pre [chuck|toss|throw|put] [the|that|this] [spare copy|duplicate|installer|blurry photo|zip file|old version|first draft] [in the bin|into the trash|in the trash|in the recycle bin] $post',
    '$ask [where did i put|where did i save|where have i put|where on earth is] [that|the|my] [pdf|document|spreadsheet|scanned copy|signed form|photo of the receipt|voice memo|slide deck] [about the house|from the bank|for the visa|from the lawyer|for work|]',
    '$pre [summarize|summarise|read me|go through|tell me what is in|what does it say in|what is in] [the|my] $file [|pdf|document|file|from the bank|for me] $post',
    '$pre [find|show me|get me] [all my|my|the] [pdfs|photos|screenshots|spreadsheets|presentations|videos|voice memos|documents] [from last week|from today|from yesterday|from this month|in downloads|on the desktop|about the trip] $post',
    "[where have i saved|i can't find|help me find|where on earth is|have you seen] my $file [|again|please|anywhere]",
    '$pre [pull up|open|bring up|show me|find] the [spreadsheet|document|doc|file|deck|pdf|presentation|draft] i was [editing|working on|looking at|writing|reading] [yesterday|this morning|last night|earlier|on friday|last week]',
    '$pre [chuck|throw|put|move|toss|send|stick] the [old|last|first|previous|earlier] [draft|version|copy|file|one] [in|into|to] the [bin|trash|recycle bin|rubbish]',
    '$pre [give me|write me|make me|do] a [summary|quick summary|rundown|short version|recap] of [the|my] $file [|pdf|document|file|please]',
  ],
  clipboard: [
    "$ask [what's on|what is on|what's in|read me|what do i have on|check] [my|the] clipboard [|right now|now|at the moment]",
    '$ask [what did i copy|what have i copied|what did i just copy|what was the last thing i copied|read back what i copied] [|just now|earlier|a minute ago]',
    '$pre [copy|put|save|stick] [that|it|your answer|what you just said|the answer|your last reply|the last answer|that reply] [|to my clipboard|to the clipboard|onto the clipboard|for me] $post',
    '$pre [copy|grab|get me|give me] [the link|the url|the web address|the link to this page|the url of this site|this page address] [|for me|to my clipboard|please|so i can paste it] $post',
    '$pre [stick|put|pop|copy|throw|place] [that|your last answer|what you just said|the answer|your reply|this|that text] [on|onto|to|into] [my|the] clipboard $post',
    "$pre [grab|copy|get|take] [the address|the link|the url|the web address] [of|for|from] [this page|this site|the page i'm on|this tab] $post",
  ],
  run_shortcut: [
    '$pre [run|start|trigger|launch|do|fire off|kick off|use] [my|the] $shortcut shortcut [|for me|please|now]',
    '$pre [run|start|trigger] the shortcut [called|named] $shortcut $post',
    '$pre [run|use] [my|the] [translate|summarize|dictate|log mood] shortcut [on|with] [hello|this text|good morning|thank you|the last message] $post',
    "$ask [what shortcuts do i have|which shortcuts have i got|list my shortcuts|show me my shortcuts|read me my shortcuts|what shortcuts can you run]",
    '$pre [fire off|kick off|trigger|set off|start up] [my|the] $shortcut [shortcut|automation] $post',
  ],
  ui_control: [
    '$pre [click|tap|press|hit|click on] [send|reply|submit|ok|cancel|next|continue|save|accept|sign in|log in|done|close|allow|confirm|agree|reply all|forward|delete|archive] [|button|link|please|for me]',
    '$pre [double click|double-click|right click|right-click] [the file|the icon|the folder|the report|that|the picture|the link|the message] $post',
    '$pre [type|write out|enter|key in|type out] [hello there|thank you|on my way|see you at five|yes please|i will be late|the meeting is moved|happy birthday|sounds good|no problem|call me later] [|and press enter|then hit return|please|for me]',
    '[type in|write in|put in] [hello there|thank you|on my way|see you at five|running late|love you|all good|two minutes] [|and hit enter|then press return|please]',
    '$pre [press|hit|tap|push] [enter|return|escape|tab|space|the down arrow|the up arrow|delete|backspace|command s|command z|command c|command v|command shift t|control c|command w|command tab|f5|page down] [|twice|three times|again|please]',
    '$pre scroll [up|down|left|right|to the top|to the bottom|down a bit|up a little|all the way down|down a lot] [|please|a bit|a lot|the page|this page|for me]',
    '$pre [go to|jump to|take me to] the [top|bottom] of the [page|list|document|chat|thread] $post',
    '$pre [select|highlight] [all|everything] [|please|the text|on the page]',
    "$pre [type|type in|type out|write in|enter|put in|key in] [thanks so much|on my way|sounds good to me|hello there|call me later|i'll be there soon|ok thanks|running late|see you soon|happy birthday]",
  ],
  computer_task: [
    '$pre [use the computer to|go on the computer and|use my mac to|take over and|use the browser to|go online and] $chore $post',
    '$pre [can you|could you|please] [do this for me on the screen|take over the mouse|drive the mouse for me|sort this out on the computer|fill this out for me|click through this for me|go through the checkout for me|do the clicking for me] $post',
    '[go to|open|head to] [amazon|jumia|the airline website|booking.com|the bank website|my gmail|the tax portal|the school portal] and [order|book|pay|find|check|cancel|download] [the batteries|a hotel for friday|my bill|the receipt|my booking|the statement|the cheapest one|my results] [|for me|please]',
    "[i want you to|i need you to|you can] [take over|use the computer|handle this on screen|do it on the screen] [and|to] $chore",
    "$pre [go on|go to|hop on|get on|jump on] [amazon|jumia|ebay|the airline site|the bank website|netflix|the shop's site] and [reorder|order|buy|book|find|cancel] [my usual|the same|another|a new|more] [coffee|printer ink|phone case|charger|ticket|shoes|groceries|vitamins]",
  ],
  undo: [
    '$lead [undo|revert|reverse|take back] [that|it|the last thing|what you just did|the last change|that change] $post',
    "$lead [undo|revert] [what {agent} did|{agent}'s changes|what {agent} changed|the agent's changes]",
    '$lead [put it back|put things back|go back] [the way it was|how it was|to how it was before]',
  ],
  activity_report: [
    '$ask [what did you do|what have you done|what did you get done|tell me what you did] [|today|yesterday|this week|so far today]',
    '$ask [what did {agent} change|what has {agent} done|what did {agent} do] [|today|yesterday|in the project]',
    '$ask [show me|give me] [your activity|a log of what you did|the record of today]',
  ],
  stop_everything: [
    '$lead [stop|halt|abort|freeze|kill] [everything|it all|all of it|everything you are doing] [|now|right now|immediately|please]',
    '[emergency stop|panic stop|shut it all down|everything stop] [|now|please|right now]',
    // Everything, all at once - never a bare "stop", which is just "stop talking".
    '$lead [stop|halt|cancel|end|kill|abort|drop] [every task|all the tasks|all the agents|every agent|all of this|the whole lot] [|now|right now|at once|immediately]',
    "$lead [stop|drop] everything [you're doing|you are doing|at once|this second|and stop listening|and mute the mic]",
    '[pull the plug on everything|hit the kill switch|kill switch|stop the lot|shut everything down|shut down everything|everything off] [|now|please|right now]',
    '$lead [stop|halt|freeze] all [of it|of that|of this|the work|the clicking|activity|actions] [|now|right now|please]',
  ],
  permissions: [
    '$ask [what have i allowed|which permissions have i given you|what permissions have i given you|what did i say always to|what have i let you do without asking] [|you|so far]',
  ],
  remind: [
    '$pre [remind me to|remind me i need to|set a reminder to|make a reminder to|create a reminder to] $todo $when $post',
    '$pre [remind me|set a reminder|put a reminder in] $when to $todo $post',
    '$pre [remind me|set a reminder] $when [about the dentist|about the meeting|about the rent|about the team lunch] $post',
    '$pre $when [remind me to|please remind me to|i need a reminder to] $todo',
    '$pre [remind me to|remind me i should] $todo $every',
    '$every [remind me to|please remind me to] $todo',
    '$pre [add|put] $todo [to|in|on] [my reminders|the reminders app|my reminders list] $post',
    "[don't let me forget to|remember to|don't forget to] $todo $when",
  ],
  reminders: [
    '$ask [what are my reminders|what reminders do i have|do i have any reminders|what have you got to remind me about|read me my reminders|list my reminders] [|today|tomorrow|this week|for today|for tomorrow]',
    "$ask [what's|what is] [coming up|on my list] [today|tomorrow|this week]",
  ],
  cancel_reminder: [
    '$pre [cancel|delete|remove|scrap|get rid of|clear] [the|my] reminder to $todo',
    '$pre [cancel|delete|remove|scrap|clear] [the|my] reminder [about the dentist|about the rent|for tomorrow|for friday|at 5]',
    '[stop reminding me to|no need to remind me to|you can stop reminding me to] $todo',
  ],
  snooze_reminder: [
    '$lead [snooze|snooze it|snooze that|snooze the reminder] [|for a bit|please|for now]',
    '$lead [snooze|snooze it|snooze that|snooze the reminder] for $dur',
    '$lead [remind me again|ask me again|tell me again] in $dur',
    '$lead [remind me again|ask me again|tell me again] [later|in a bit|a bit later]',
  ],
  brief: [
    "$ask [brief me|give me my briefing|give me the briefing|run me through my day|catch me up|what's my day like|what's on today|what does my day look like|how does today look|what have i got today] $post",
    '[good morning|morning] [|nova|hey nova|how are things|what have we got today|brief me]',
  ],
  missed: [
    "$ask [what did i miss|did i miss anything|anything while i was away|what happened while i was out|did anything come up|anything new since i left] [|while i was in the meeting|while i was on the call|this afternoon|today]",
  ],
  task_status: [
    "$ask [what's|what is] [{agent}|the agent|the coding agent] [doing|working on|up to] [|now|right now]",
    "$ask [is|has] [{agent}|the agent] [done|finished|still working] [|yet|with the task|with it]",
    "$ask [how's|how is] [{agent}|the agent|the task|my task] [getting on|going|coming along]",
    "$ask [what did|what has] [{agent}|the agent] [say|find|report|come back with]",
  ],
  set_project: [
    "$pre [i'm working on|we're working on|switch to|let's work on|my current project is|set my project to|move over to] {project} [|today|now|for now|from now on]",
  ],
  create_routine: [
    "[when i say|whenever i say|if i say] [start work|good night|focus time|lunch time|standup|let's go|wrap up] [open slack|brief me|mute yourself|quit slack|open zoom|tell me my reminders|open my email] [|and brief me|and open linear|then read my reminders|and quit spotify]",
    '$every [open slack|brief me|open my email|open linear|quit slack] [|and brief me|and read my reminders|then open my calendar]',
    '[make|create|set up|add] a routine [for the morning|for when i start work|called focus|for bedtime|that opens slack]',
  ],
  open_app: [
    '$pre [open|open up|launch|start|start up|fire up|bring up|pull up|load|boot up|run|switch to|go to|show me|show|get me|take me to|put up|get me into|focus|switch over to|head to|pop open] {app} $post',
    '$pre [open|launch|start|bring up|pull up|show] the {app} [app|application|program] $post',
    "[i need|i want|i'd like|let me|i wanna|i gotta|i have] [to use|to open|to see|to check|to get into|to work in|to go to] {app} $post",
    '[i need|i want|gimme|give me|get me|i would like] {app} [|open|up|please|now|on the screen]',
    '[can i|could i|can we|could we|may i] [get|have|see|open|use] {app} $post',
    '[put|bring|get] {app} [on the screen|up|to the front|in front|on|open]',
    "[let's|time to|i should] [open|use|get into|go to|check] {app}",
    '[open|launch|start|pull up|bring up] {app} [i need to reply to a message|i have a meeting soon|i want to listen to music|so i can take notes|i have to send an email|i need to finish something|for my call|to check something|i need it]',
    '[um|uh|er|so|okay|like] [open|launch|start] [uh|um|like|] {app}',
    '$pre [flip|flick|hop|jump|pop|skip|swing|nip|zip] [over to|across to|into|to|back to|back into|straight into] {app} $post',
    "[i would really like|i'd really like|i'd love|i really need|i just want] [to open|to launch|to start|to pull up|to bring up|to get into] {app} [|please|now|for a sec|real quick]",
    "[open|launch|start|pull up|bring up] {app} [i have to finish my|i need to finish the|i want to work on my|so i can finish my|i've got to update my] [slides|report|presentation|essay|homework|code|spreadsheet|design|budget|notes]",
    '[stick|throw|chuck|pop] {app} on [|for me|please|now]',
    '[take me|bring me|get me] [over to|back to|into] {app} [|please|now]',
  ],
  quit_app: [
    "$pre [quit|close|exit|shut down|shut|kill|force quit|terminate|end|close out|close down|get rid of|dismiss|stop|force close|close out of|quit out of|exit out of|turn off|switch off] {app} [|please|for me|now|right now|it's frozen|it's not responding|i'm done with it|completely|it keeps crashing|it's slowing everything down]",
    '$pre [quit|close|exit|shut down] the {app} [app|application|program] $post',
    "[i'm done with|i'm finished with|no more|enough] {app} [|close it|quit it|shut it down|kill it]",
    '[make|have|get] {app} [quit|close|shut down|go away]',
    '{app} [can go|needs to close|has to go|off|close|quit]',
    '[shut|close|kill] {app} [down|off]',
    "[i want|i'd like|i need] {app} [closed|shut|gone|quit|shut down]",
    '$pre [ditch|lose|bin|drop|scrap|axe] {app} [|now|please|for me|for good]',
    "[i don't need|i no longer need|i'm not using|i don't use|i've finished with] {app} [anymore|any more|now|at the moment] [|close it|quit it|you can close it|get rid of it|shut it down|kill it]",
    "[{app} is done|{app} can close now|i'm through with {app}|we're finished with {app}] [|close it|shut it]",
  ],
  tell_time: [
    '$ask what time is it [|now|right now|please|at the moment|currently]',
    "$ask [what's|whats|what is] the [time|date|day|day today|date today|time now|time right now] [|please|now]",
    '$ask [tell me|give me|say|read me] the [time|date|day|current time|date today] [|please|now]',
    "$ask [do you know|can you tell me|could you tell me|would you tell me] [what time it is|the time|the date|what day it is|what the date is|today's date|what day today is]",
    '[what|which] [day|date|month|year] is it [|today|now|please]',
    '$ask what day of the [week|month] is it [|today]',
    '[is it|is it already|is it still] [morning|afternoon|evening|night|late|early|lunchtime|noon|midnight] [|yet|already|now]',
    '[time|date|day] [check|please|now]',
    "[current|today's] [time|date|day] [|please]",
    '[how late|how early] is it [|now|already]',
    "[what's|what is] [today|today's date|the day today] [|please]",
    "[what's|what is|what does] the clock [saying|say|showing|show] [|now|right now]",
    "[how's|how is] the time [looking|going] [|now|today]",
    '[is it|is it already|is it still|are we] [past|after|before|near|close to|nearly] [midnight|noon|five|six|seven|eight|nine|ten|eleven|lunchtime|dinner time|bedtime] [|yet|already|now]',
    '[are we|is it] [in|still in|already in] [january|february|march|april|may|june|july|august|october|november|december] [|already|yet|now]',
    "[remind me|tell me again|just tell me] [what the date is|what today's date is|what the time is|which day it is today]",
    "[do you happen to know|any idea|got any idea|have you got|have you any idea of] [the time|what time it is|the date|what day it is|today's date]",
  ],
  set_timer: [
    '$pre set a $dur1 timer [|please|for me|now]',
    '$pre set a timer for $dur [|please|for me]',
    '$pre [start|begin|run|put on|do|make] a [timer|countdown] [for|of] $dur [|please]',
    '[timer|countdown] [for|of|] $dur [|please]',
    '$pre [remind me|alert me|ping me|notify me|nudge me|buzz me|let me know|give me a shout|wake me up|wake me|warn me|ring me] in $dur [|please|to check the food|to call my mum|to take my pills|to stretch|to join the meeting|to move the car|to drink water|to check the oven|to take a break]',
    '$pre count down [|from] $dur',
    '$pre time [my|the|this] [talk|speech|presentation|pitch|run|workout|plank|nap|eggs|pasta|rice|study session|practice|reading] [for|to] $dur [|please|for me]',
    '$pre [time|clock] $dur for me',
    '$pre [set|start] [an alarm|a reminder] [for|in] $dur',
    '$pre let me know when $dur [are up|have passed|is up|are over]',
    '$dur1 timer [|please|now]',
    'in $dur [remind me|tell me|let me know] [|to check the stove|to call back|to switch off the iron|to leave]',
    "$pre [give me|can i get|i want|i'd like] a [heads up|warning|shout|nudge|ping] in $dur [|please]",
    '$pre [warn|ping|buzz|nudge|alert] me [in|after] $dur [|please|for me]',
  ],
  stop_listening: [
    '$pre stop listening [|now|please|for now|for a while|for a bit|to me|for a minute|to us|until i call you]',
    '$pre [turn off|switch off|disable|mute|shut off|kill|close|pause] [the|your] [mic|microphone|listening] [|please|now]',
    '[mic|microphone|listening] off [|please|now|nova]',
    '$pre [go to sleep|go back to sleep|take a nap] [|now|please|for a while|nova]',
    // Nova's own sleep and mute: the Mac's are named ("put the mac to sleep", "mute the sound").
    '$pre [sleep mode|go into sleep mode|enter sleep mode|sleep|nap time|rest mode|quiet mode|listening off] [|now|please|nova|for a while|for a bit]',
    '$pre [mute|mute yourself|go on mute|put yourself on mute|mute your mic|mute your ears] [|now|please|nova|for a bit|for a minute]',
    '$pre [stop|quit] [hearing|recording|listening to] [me|us|everything|the room] [|please]',
    "$pre [don't|do not] listen [for now|to me|anymore|for a while|until i call you]",
    '$pre mute [yourself|your mic|the mic|your microphone] [|please|now]',
    "[that's all for now|that's it for now|i'm done|we're done|okay that's all] [stop listening|go to sleep|mic off|turn off your mic]",
    "[feel free to|go ahead and|you're free to|you may] [rest|sleep|take a break|nap|switch off|stop listening] [now|for now|for a bit|for a while|]",
    '[take a rest|have a rest|have a nap|get some rest] [|now|for a bit|nova|please]',
  ],
  open_settings: [
    "$pre [open|show|bring up|pull up|go to|take me to|display|launch|show me] [your|the|nova's|nova] [settings|preferences|options|configuration|config|setup|settings page|settings window] $post",
    "$pre [i want|i'd like|i need|let me] [to change|to adjust|to tweak|to configure|to edit|to update] [your settings|your voice|your wake word|your name|your preferences|how you work|your configuration|the settings|how you sound|your speaking speed|your appearance]",
    '$pre [change|adjust|tweak|configure|update] [your voice|your wake word|your name|your settings|your speech speed|your preferences|your appearance] [|please]',
    '[settings|preferences|config|options] [|please|window|page|screen|panel]',
    "[where are|where's|where can i find] [your|the] [settings|preferences|options]",
    '[can i|can we|could i] [see|change|open|get to] [your|the] [settings|preferences|options]',
    "[where do i|how do i|how can i] [find|get to|open|reach] [your|the|nova's] [settings|preferences|options] [|page|window|screen]",
    "[i want to see|let me see|let me look at|show me] [your|the|nova's] [preferences|options|settings] [page|screen|window|panel|]",
  ],
  cancel_timer: [
    '$pre [cancel|stop|end|clear|delete|remove|kill|abort|turn off|switch off|get rid of|forget|drop|dismiss|silence] [the|my|that|this|all the|all my|all] [timer|timers|countdown|countdowns|alarm|reminder|reminders] [|please|now]',
    "$pre [no more|never mind the|forget the|i don't need the|i don't need my] [timer|countdown|alarm|reminder]",
    '[timer|countdown|alarm] off [|please]',
    '$pre [cancel|stop|end] the $dur1 [timer|countdown] [|please]',
  ],
  agent_task: [
    '$lead [ask|tell|get] {agent} to $task $where [|please]',
    '$lead [have|let|make] {agent} $task $where [|please]',
    '{agent} [|please|can you|could you] $task $where [|please]',
    '[can|could] {agent} $task $where',
    "[i want|i need|i'd like] {agent} to $task $where",
    '$lead [ask|get|tell] the [agent|coding agent] to $task $where',
    '$lead [have|let] the [agent|coding agent] $task $where',
  ],
  cancel_task: [
    "$pre [stop|cancel|abort|halt|kill|end|call off|pause] [the agent|{agent}|the agents|all agents|the coding agent|the task|the job|the agent task|the agent's work|what {agent} is doing|{agent}'s task|the coding task|the coding job|all the tasks|the running task] [|please|now]",
    '$pre tell {agent} to [stop|cancel|quit|halt|stop working|drop it|give up|stand down]',
    '$pre make {agent} stop [|working|now]',
    '{agent} [stop|halt|cancel|stop working|drop it|enough]',
    '[the agent|{agent}] [should stop|can stop|needs to stop|must stop] [|now|working]',
  ],
  stop: [
    "[|nova|okay|alright|hey|please|ok] [stop|stop it|stop that|stop talking|stop speaking|be quiet|quiet|silence|shh|shush|hush|enough|that's enough|never mind|forget it|forget that|cancel|cancel that|nevermind|skip it|hold on|wait|stop stop|no need|drop it|that will do|shut up|zip it|pause] [|please|now|nova|thanks|thank you]",
    "[you can stop|you can be quiet|no need to continue|don't finish that|don't say more|that's all i needed|i've heard enough|okay i got it|got it thanks|thanks that's enough]",
    // A bare "forget it" drops what's going on; forgetting a memory names the memory.
    '[|oh|actually|no|nah|wait|nova] [forget it|forget that|forget about it|forget about that|forget i said anything|forget i asked|just forget it] [|then|please|nova|thanks|for now]',
  ],
  confirm_yes: [
    "[yes|yeah|yep|yup|yea|sure|ok|okay|alright|all right|fine|of course|absolutely|definitely|certainly|correct|right|affirmative|totally|for sure|yes please] [|please|go ahead|do it|go for it|that's right|thanks|please do|sure|do that|go on|proceed|that's fine|i'm sure]",
    "[go ahead|do it|go for it|please do|proceed|carry on|continue|go on|make it so|let's do it|sounds good|that works|perfect|approved|allow it|you may|you can] [|please|then|now|thanks]",
  ],
  confirm_no: [
    "[no|nope|nah|no no|no way|not now|not yet|never|negative|don't|no thanks|no thank you|not really|not at all|absolutely not|definitely not|of course not|hold off|wait no|actually no] [|don't do it|leave it|thanks|please|that's wrong|not that|keep it|i changed my mind|don't bother]",
    "[don't|do not|please don't] [do it|do that|bother|touch it|close it|quit it|allow it|go ahead|proceed|do anything]",
    '[leave it|keep it|leave it alone|keep it open|skip it|skip that|deny|decline|refuse|reject it] [|please|thanks|as it is|for now]',
  ],
  remember: [
    "$pre [remember|remember that|don't forget that|keep in mind that|note that|make a note that|please remember that|can you remember that] $fact",
    "[remember this|save this|note this down|make a note] [|for me] $fact",
    "[don't forget|keep in mind|remember] $fact",
  ],
  recall: [
    '$ask [what do you remember|what do you know|what did i tell you|what have i told you] about [me|my schedule|my family|my work|my car|my standup|the deadline|my flight|my preferences|my manager|the project|myself]',
    "$ask [do you remember|do you know|can you remind me] [my birthday|when my standup is|my manager's name|what i told you about the deadline|my gym days|where the meeting room is|what car i drive|when my flight is]",
    '[tell me|list|read me] [what you remember|everything you remember|what you know about me|my memories]',
    "[do you remember|did i tell you|do you recall|can you recall] [when|where|what|who|how] [my dentist appointment is|my car is|i work|my sister lives|my flight leaves|the meeting is|my manager is|the office is]",
  ],
  forget: [
    "$pre [forget|forget that|please forget that|you can forget that|delete the memory that|erase the note that] $fact",
    '$pre [forget|delete|erase|remove] [what i told you about|the memory about|the note about|what you know about|what you remember about] [my car|the deadline|my flight|my manager|the wifi|my gym days|my old address|the office|my standup]',
  ],
  chat: [
    '[what is|explain|tell me about|describe|define|what do you know about] $topic',
    "[how do i|how can i|what's the best way to|how should i] $howto",
    '[can you|could you|please|help me] [write|draft|compose] [a poem|an email|a message|a tweet|a short story|a summary|a cover letter|a toast|a speech|a thank you note|a joke|a limerick] [about my weekend|to my boss|for my sister|about the rain|for a job application|about friendship|for a birthday|about coffee|to a client|about football]',
    '[who invented|who discovered|who wrote|who founded|who made] [the telephone|the light bulb|microsoft|the theory of relativity|harry potter|apple|facebook|penicillin|the printing press|things fall apart|the radio|the airplane|google|the world wide web|the television]',
    "[what's|what is] the [capital|population|currency|main language|national dish|time zone] of $country",
    '[how many|how much|how long|how far|how old|how big|how tall] [people live in london|does a flight to london take|is the great wall of china|is the eiffel tower|is the earth|water should i drink a day|does it take to learn french|calories are in an egg|is it from accra to lagos|legs does an octopus have|teeth do adults have|planets are there|is mount everest|does an iphone cost]',
    '[is|are|can|does|should] [coffee good for you|dogs see colors|it healthy to skip breakfast|i learn rust first|ai going to take our jobs|cats like water|it safe to eat raw eggs|electric cars better than petrol cars|plants feel pain|bananas a berry|eggs bad for you|a hotdog a sandwich]',
    '[recommend|suggest|give me] [a good book|a movie|a podcast|a recipe|some music|a name for my cat|a gift idea|a place to visit|a workout|a hobby] [|for tonight|for the weekend|for a beginner|for my mum|to try]',
    '[why does|why do|what makes] [bluetooth|a vpn|airdrop|icloud|spotlight|screen recording|a laptop battery] [use so much battery|slow my mac down|keep disconnecting|need permission|get hot]',
    '[why does|why is|how come] [my battery|my mac|my laptop|my phone|wifi|the fan|my headset] [drain so fast|die so quickly|get so hot|keep dropping|keep disconnecting|so slow|so loud] [|lately|these days|all of a sudden|when i play music]',
    "[what's|what is] a good [song|album|podcast|playlist|book|movie|show] [to study to|for a road trip|to fall asleep to|for running|for a party|to learn spanish]",
    "[summarize|summarise|give me a summary of|sum up] [the news|this week in tech|the history of ghana|the plot of hamlet|the book of ruth|what happened in the election|today's headlines|the premier league season]",
    '[who painted|who sang|who directed|who built|who composed] [the last supper|thriller|titanic|the eiffel tower|the four seasons|starry night|the pyramids]',
    '[what is|what are|explain] [dark mode|a keyboard shortcut|the clipboard|focus mode|a vpn|spotlight search|a window manager|file syncing] [for|good for|exactly|to me|and why use it]',
  ],
  other: [
    '[the|a] [minister|president|police|government|company|court|coach|mayor|spokesperson|chairman|senator|governor|union|hospital] [said|announced|confirmed|denied|reported|warned|revealed|claimed|insisted|admitted] [|that] [the talks would continue|prices will rise next month|the road will be closed|the match was postponed|the suspect was arrested|the results are due tomorrow|the budget was approved|the strike is over|the factory will close|profits fell sharply|the vote was delayed|nobody was injured|the bridge will reopen|schools will reopen on monday|the deal is done]',
    '[and|oh|] [he|she|they] [scores|shoots|passes|misses|saves it|crosses it|heads it|clears it|takes the penalty] [what a goal|in the last minute|from distance|into the top corner|over the bar|wide of the post|and the crowd goes up|]',
    "$person [where is|where are|have you seen|did you see|can you bring|please bring|don't forget] [my keys|the remote|my phone|the charger|my bag|the car keys|my glasses|my shoes|the umbrella|the baby's bottle]",
    '[close|open|shut|lock|unlock] the [door|window|gate|fridge|curtains|garage|car|cupboard|tap] [please|behind you|when you leave|for me|quickly|]',
    '[stop|quit|no more] [running|shouting|fighting|playing|crying|doing that|touching that|eating so fast|making noise|jumping|arguing|teasing her] [please|now|in the house|right now|]',
    '[what time|when] [are we leaving|is the party|does the movie start|will you be back|is dinner|does your flight land|is the meeting tomorrow|do the kids finish school|does the shop open|are they coming|is the wedding|is your exam]',
    '[the|my|our] [zoom call|zoom meeting|slack channel|spotify playlist|chrome tabs|teams meeting|whatsapp group|email|notion page|calendar|laptop|phone] [is|was|keeps|has been] [crashing|down|so slow|full of messages|broken|annoying|updated|lagging|freezing|getting hot]',
    "[i'll|i will|we'll|she'll|he'll|they'll] [be there|call you|finish it|send it|come back|be ready|be home|join you|pick you up] in [five minutes|ten minutes|an hour|half an hour|twenty minutes|two minutes|a bit]",
    "[you're|you are] [on mute|breaking up|frozen|lagging|not sharing your screen|too quiet|cutting out]",
    "[turn|put] [the telly|the tv|your music|the radio|that noise|your phone] [down|up|off] [|please|i'm on the phone|the baby is sleeping|we can't hear ourselves|it's late]",
    '[did you|have you|can you] [click the link|see the file|get the pdf|copy the notes|move the photos|save the document|send the spreadsheet|rename the folder] [i sent you|i shared|from the meeting|in the group chat|from yesterday|for me] [|yet|already]',
    '[he|she|they|my brother|my boss|the intern] [clicked|typed|copied|deleted|moved|renamed|minimized|muted] [the wrong thing|everything|the file|all the photos|the whole folder|the meeting|the wrong button] [again|by accident|last week|this morning|]',
    '[the|my] [screen|volume|brightness|battery|keyboard|mouse|trackpad] [on this laptop|at work|at home|on my phone|on the old mac|] [is|was|keeps] [terrible|so bad|acting up|dying|broken|not working|too loud|flickering]',
    '[the|that|a] shortcut [through the park|to the station|via the motorway|behind the market|past the school] [is closed|saves ten minutes|is quicker|was flooded|is too dark at night]',
    '[smash|hit|tap] [that like button|the subscribe button|the bell icon|the notification bell] [|below|down below|so you never miss a video|if you enjoyed this|right now]',
    '[the link|links|the discount code|the full recipe|the sponsor link|the tickets] [is|are] [in the description|down below|in the bio|pinned in the comments|in my stories]',
    '[just|please|can you|did you] [click|open|check] the link i [sent you|shared|posted|dropped] [on whatsapp|by email|on slack|last night|this morning]',
    '[i|we|she|he|they] [moved|backed up|saved|put|uploaded] [the pictures|the documents|the videos|all the songs|the wedding photos] [to|onto] [the cloud|the old laptop|a usb stick|google drive|dropbox] [yesterday|this morning|last week|over the weekend|already]',
    "[can everyone|can you all|can you guys|is everyone able to|can the room] [see my screen|hear me|see the slides|see what i'm sharing|see my window] [|now|okay|yet|clearly]",
    "[let's|shall we|we should|let's go ahead and|ok let's] [start the meeting|get started|kick off the call|begin the session|wrap up the meeting|take a short break|go round the room]",
    '[the settings on|the menu on|the buttons on|the controls on|the screen on] [this camera|the new tv|my car|the microwave|the washing machine|her phone|the printer] [are confusing|are so complicated|make no sense|are hidden somewhere|are all in french]',
    '[i|we|she|he|they] [sent|emailed|printed|signed|forwarded|posted|scanned] [the invoice|the contract|the report|the form|the photos|the letter|the spreadsheet] [yesterday|last week|this morning|already|on monday|to the bank|to the landlord]',
    '[i|we|he|she|you] [left|kept|had] [chrome|safari|zoom|spotify|the game|the laptop|the browser|all those tabs] [open|running|on] [all night|all day|the whole weekend|since monday|again]',
    '[who took|who moved|who has|who borrowed|who hid] [my charger|the remote|my headphones|the scissors|my keys|the tv remote|my earphones] [|again|from the table|this time|from my room]',
    '[i|we|you|she|he] [left|forgot] [the tv|the telly|the laptop|the lights|the tap|the iron|the fan] [on|running|open] [all night|again|this morning|when we left|]',
    "[turn off|switch off|turn on|switch on] the [lights|light|fan|heater|kettle|iron|tv|telly|generator|ac] [when you leave|before bed|in the kitchen|it's late|before you go|]",
    "[open|close|shut] the [window|windows|bedroom window|car window|kitchen window] [it's hot in the car|it's stuffy|the rain is coming in|there's a draught|let some air in]",
    'the [microwave|oven|washing machine|kettle|alarm downstairs|smoke alarm|rice cooker] [is beeping|keeps beeping|has finished|is going off|just went off]',
    "[yes|no|yeah|nope|okay] [i'm coming|i'm not hungry|i did|i know|mummy|daddy|she did|he called|we're ready|it's fine|i saw it|i'll do it later|i'm on my way|go and sleep]",
    "[in today's video|on this channel|in this episode|on the show today|coming up next|after the break|later in the programme] [we're going to|we will|i'll|let's] [look at|talk about|review|test|cook|build|explore|discuss] [the new iphone|a simple recipe|the latest news|my morning routine|the best budget laptops|the election results|a new game|the history of ghana]",
    '[smash that like button|hit the like button|hit subscribe|subscribe and hit the bell|ring the bell for notifications|check out the link below|the links are in the description|use my code at checkout|leave a comment below|let me know in the comments|see you in the next video|thanks for watching|this video is sponsored by|drop a comment below|share this with a friend|follow me for more]',
    '[stop jumping on the bed|put your shoes on|finish your homework|turn off the tv and go to bed|close the door behind you|switch off the fan when you leave|lock the door on your way out|stop shouting|come and eat|wash your hands before dinner|take the bins out|put your toys away|brush your teeth|stop fighting you two]',
    "[you're breaking up|you're muted|unmute yourself|can everyone see my screen|let's take this offline|i'll share my screen|sorry you cut out|i think you're on mute|can you repeat that|you froze for a second|let's circle back on that|who just joined]",
    "[the oven timer went off|my alarm didn't go off|i set a timer for the rice|the clock in the kitchen is slow|i was on the phone for an hour|i closed the shop early|he opened the window|she quit her job|did you lock the front door|what time are you coming home|i'll be home by six|the kettle is boiling|my phone's clock is wrong]",
    '[i left the lights on|i opened the fridge and it was empty|she closed the laptop and left|he switched off the radio|they muted the tv|the music in the car was too loud|did you turn the heater off|i forgot to charge my laptop]',
  ],
};

/** A small, fast, seeded random number generator, so the same patterns always give the same phrasings. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every phrasing a pattern stands for, or an even sample of them (the same one every time) when there are more than `cap`. */
export function expand(pattern: string, cap = Infinity, seed = 1): string[] {
  const full = pattern.replace(/\$(\w+)/g, (m, name: string) => LISTS[name] ?? m);
  const parts = full.split(/(\[[^\]]*\])/).map((p) => (p.startsWith('[') ? p.slice(1, -1).split('|') : [p]));
  const total = parts.reduce((n, options) => n * options.length, 1);
  const random = seeded(seed);
  const pick = (index: number) => {
    let rest = index;
    return parts
      .map((options) => {
        const option = options[rest % options.length]!;
        rest = Math.floor(rest / options.length);
        return option;
      })
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
  };
  if (total <= cap) return [...new Set(Array.from({ length: total }, (_, i) => pick(i)))];
  const chosen = new Set<string>();
  for (let tries = 0; chosen.size < cap && tries < cap * 20; tries++) chosen.add(pick(Math.floor(random() * total)));
  return [...chosen];
}

/**
 * Background speech and open questions cover far more ground than any one request (every kind of
 * talk that isn't for Nova, every subject): they keep more of their phrasings.
 */
const WIDER: Record<string, number> = { other: 1500, chat: 900 };

/** Grammar phrasings per intent: each pattern sampled up to `perPattern`, each intent up to `perIntent` (more for the wide ones). */
export function grammarPhrases(grammar = REFLEX_GRAMMAR, perPattern = 150, perIntent = 600): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [intent, patterns] of Object.entries(grammar)) {
    const all = [...new Set(patterns.flatMap((p, i) => expand(p, perPattern, i + 1)))];
    const cap = Math.max(perIntent, grammar === REFLEX_GRAMMAR ? (WIDER[intent] ?? 0) : 0);
    const random = seeded(intent.length * 7919 + all.length);
    out[intent] = all.length <= cap ? all : all.map((p) => ({ p, r: random() })).sort((a, b) => a.r - b.r).slice(0, cap).map((x) => x.p);
  }
  return out;
}
