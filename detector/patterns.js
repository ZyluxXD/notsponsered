// Direct, current-tense disclosures are safe enough to open a sponsor
// candidate without requiring another commercial cue.
export const STRONG_START_PATTERNS = [
    /\b(?:today'?s|this) (?:video|episode|show|podcast) (?:is )?(?:sponsored|brought to you)\b/, //
    /\b(?:this (?:video|episode|show|podcast)|this) is (?:sponsored|brought to you) by\b/,
    /\bthis (?:part|portion|segment) of (?:this|the) (?:video|episode|show) is sponsored by\b/,
    /\b(?:sponsor|sponsorship|partner) (?:of|for) (?:today'?s|this) (?:video|episode|show|podcast)\b/,
    /\b(?:today['’]?s|this (?:video|episode|show|podcast)(?:['’]s|s)?) sponsor(?=\s+(?:is|has|can|will)\b|[,:])/,
    /\bthe sponsor for today is\b/,
    /\b(?:it is|it['’]?s) (?:the |this )?(?:video|episode|show|podcast)(?:['’]s|s)? sponsor\b/,
    /\b(?:before we (?:continue|begin|get started|keep going)|but first|real quick).{0,100}\b(?:sponsor|partner)\b/,
    /\bsupport for (?:this|the) (?:show|podcast|episode|video) comes from\b/,
    /\bpaid promotion\b/,
    /\bi (?:want|have|got|need) to (?:talk|tell you) about (?:(?:today'?s|this)(?: (?:video|episode|show)(?:'s|s)?)?) sponsor\b/,
    /\b(?:thanks?|thank you) to .{1,60} for sponsoring (?:today'?s|this|the|our) (?:video|episode|show|podcast)\b/,
];

export const ENDORSEMENT_START_PATTERNS = [
    /\b(?:i|we) (?:really |absolutely |especially )?(?:like|love|use|recommend) (?:our|the) sponsor\b/,
];

// These introductions are common in sponsor reads, but also occur naturally in
// acknowledgements and ordinary conversation. They must be corroborated by
// independent commercial evidence before a segment is accepted.
export const CONTEXTUAL_START_PATTERNS = [
    /\b(?:a )?(?:quick|brief) (?:word|message) from\b/,
    /\bmade possible by\b/,
    /\b(?:in partnership with|partnered with|sponsored by|brought to you by|presented by)\b/,
    /\bbut before we (?:get|go|move|return) (?:to|back to) (?:that|it|the (?:story|video|scene|topic|case))\b/,
    /\b(?:our|some) friends at\b/,
    /\bthey reached out to (?:me|us)\b/,
    /\bwhen .{0,40} offered to sponsor\b/,
    /\b(?:today['’]?s|this (?:video|episode|show|podcast)(?:['’]s|s)?) sponsor$/,
    /\b(?:thanks?\s+to|thank\s+you\s+to|thank)\s+(?!(?:you|all|everyone|everybody|viewers?|subscribers?|members?|fans?|audience|community|supporters?)\b).{1,60}?\s+for\s+support(?:ing)?\b/,
    ...ENDORSEMENT_START_PATTERNS,
];

// Rhetorical setup used immediately before an endorsement-style disclosure.
// Multiple cues are required before this can move a boundary backwards.
export const SPONSOR_LEAD_IN_PATTERNS = [
    /\bthere (?:is|was) (?:only )?(?:one|a) (?:small |tiny |minor )?problem\b/,
    /\bjust kidding\b/,
    /\b(?:one|another) (?:angle|part|aspect|piece|element|way) of\b/,
    /\b(?:is|are|can be|makes?) (?:a |an )?(?:great|good|excellent|convenient|easy|healthy) (?:option|choice|way)\b/,
    /\bif you['’]?re (?:the kind of (?:person|people)|someone who)\b/,
    /\bif you are (?:the kind of (?:person|people)|someone who)\b/,
    /\b(?:maybe|perhaps) (?:part of )?the reason\b/,
    /\b(?:that['’]?s|this is|which is) (?:exactly )?why\b/,
    /\b(?:it can be|it['’]?s|it is) (?:hard|tough|difficult|expensive|confusing|time-consuming) to\b/,
    /\b(?:all|so much) this talk about .{1,80}\breminded (?:me|us)\b/,
    /\b(?:my team and i|we|i) (?:have |['’]?ve )?(?:seen|noticed|experienced|faced) (?:a |an )?(?:massive |major |significant )?(?:increase|rise|problem|risk|challenge)\b/,
    /\b(?:making|which makes|that makes) (?:my|our|the) .{0,60} (?:harder|riskier|more difficult|less safe)\b/,
    /\bi (?:have |['’]?ve )?(?:actually )?almost (?:clicked|entered|shared|downloaded|fallen for)\b/,
    /\b(?:i am|i['’]?m|we are|we['’]?re) (?:trying|looking) to (?:find|figure out|get|choose|arrange|prepare)\b/,
];

export const SELF_PROMOTION_START_PATTERNS = [
    /\bcan i (?:do|show|talk about) (?:the |my |our )?merch(?:andise)? now\b/,
    /\bmerch alert\b/,
];

// fuzzy search phrases for detection start of sponsors
export const FUZZY_START_PHRASES = [
    "this video is sponsored by",
    "this episode is sponsored by",
    "brought to you by",
    "support for this show comes from",
    "this portion of the video is sponsored by",
    "thanks to our sponsor",
];

// regex end patterns to detect when a sponsored ad is over
export const END_PATTERNS = [
    /\b(?:thanks?|thank you).{0,80}\bto (?:our|the|this) sponsor\b/,
    /\band thank you\s+(?!to\b)(?!(?:all|everyone|everybody|you all)\b).{1,60}?\s+for sponsoring (?:today['’]?s|this|the|our) (?:video|episode|show|podcast)\b/,
    /\bthank you again (?:to|for) sponsoring (?:this|the|our) (?:video|episode|show|podcast)\b/,
    /\b(?:now |and )?(?:let'?s|we can) (?:get |go )?back to (?:it|the|this|our)\b/,
    /\bback to (?:the|our|this) (?:video|story|show|episode|topic|podcast)\b/,
    /\b(?:with that|that'?s).{0,25}\bout of the way\b/,
    /\b(?:now|anyway),? (?:let'?s|we'?ll) (?:continue|move on|get started)\b/,
    /\b(?:and now|now),? back to\b/,
    /\b(?:okay|all right),? [a-z0-9_-]+,? (?:cool|great|nice) (?:app|service|product),? but\b/,
];

// outro phrases start after the sponsored content has already ended
export const END_BEFORE_PATTERNS = [
    /\b(?:but |and )?(?:thanks?|thank you)(?: (?:all|everyone|everybody|you all))?(?: so much)? for watching\b/,
    /\bbut (?:yeah,? )?i think that'?s about all i (?:have|had) to say\b/,
    /\bwith that (?:said|covered|done),? (?:let['’]?s|we can) (?:get |go )?back to\b/,
    /\bi think (?:the |our )?(?:contestants?|guests?|players?|participants?|judges?|hosts?|crew|team) (?:is|are)(?: now)? coming back\b/,
    /\b(?:thanks?|thank you) to (?!all\b|everyone\b|everybody\b|you all\b).{1,60}\b(?:so|now|anyway),? (?:how|why|what|when|where|who)\b/,
];

// fuzzy search phrases to detect when a sponsored ad is over
export const FUZZY_END_PHRASES = [
    "thank you for sponsoring this video",
    "let's get back to it",
    "back to the video",
    "with that out of the way",
];

// regex patterns to detect pre-roll ads
export const PRE_ROLL_PATTERNS = [
    /\b(?:before we (?:continue|begin|get started|keep going)|but first|real quick|quickly before)\b/,
    /\bbut before i\b/,
];

// regex patterns to detect signals that a sponsor ad is being read
export const SIGNAL_PATTERNS = {
    sponsor: [
        /\b(?:sponsor|sponsored|sponsoring|sponsorship|partnered|partnership)\b/,
        /\bpaid promotion\b/,
        /\b(?:thanks?\s+to|thank\s+you\s+to|thank)\s+(?!(?:you|all|everyone|everybody|viewers?|subscribers?|members?|fans?|audience|community|supporters?)\b).{1,60}?\s+for\s+support(?:ing)?\b/,
    ],
    code: [
        /\b(?:promo|promotional|discount|referral)\s?code\b/,
        /\buse (?:my|the) (?:promo |promotional |discount |referral )?code\b/,
        /\b(?:use|using|with) (?:my|our|the) (?:promo |promotional |discount |referral )?code\b/,
    ],
    offer: [
        /\b\d{1,3}\s?(?:%|percent)\s?off\b/,
        /\$\d{1,4}\s?off\b/,
        /\b(?:special|exclusive|limited[- ]time) offer\b/,
        /\b(?:free|risk[- ]free) trial\b/,
        /\bfree (?:assessment|consultation|estimate|quote|evaluation|audit|analysis|demo|plan)\b/,
        /\b(?:full|complete) refund\b/,
        /\b(?:exclusive )?\d{1,3}\s?(?:%|percent) discount\b/,
        /\bmoney[- ]back guarantee\b/,
        /\bfirst \d+\s?(?:people|viewers|subscribers|orders|customers)\b/,
        /\b(?:save|get) \d{1,3}\s?(?:%|percent)\b/,
        /\b(?:try .{0,60} )?(?:completely )?for free for \d{1,3} (?:days?|weeks?|months?)\b/,
    ],
    url: [
        /\b[\w-]+\.(?:com|io|co|gg|net|org|app|tv|ai|me|dev|tech|store|shop|games|cloud|xyz|ly|link|site)(?:\/[\w./-]+)?\b/,
        /\b[\w-]+ dot (?:com|io|co|gg|net|org|app|tv|ai|me|dev|tech|store|shop|games|cloud|xyz|ly|link|site)(?: slash [\w-]+)?\b/,
        /\blink in (?:the )?(?:description|bio|show notes)\b/,
        /\bclick (?:on )?the link below\b/,
        /\bqr code\b/,
    ],
    cta: [
        /\b(?:go|head) (?:to|over to) (?:the )?(?:link|website|site|app|store|shop)\b/,
        /\b(?:use|follow|open) (?:the |my |our )?link in (?:the )?(?:description|bio|show notes)\b/,
        /\byou should check out\b/,
        /\b(?:do |please )?check out (?:the )?[a-z0-9-]+\b/,
        /\b(?:check|try) (?:it|them|the app|the link|[a-z0-9-]+) out\b/,
        /\brecommend (?:checking|trying) (?:it|them|the app|the service|[a-z0-9-]+) out\b/,
        /\b(?:sign up|subscribe|join|download|install) (?:now|today|for free|with|using)\b/,
        /\b(?:download|install)(?:ing)? (?:the |our |my )?(?:[a-z0-9-]+ )?(?:app|application)\b/,
        /\b(?:get|claim|start) (?:your|a) (?:free|first|trial|discount)\b/,
        /\bavailable (?:now |for free )?(?:on|for) (?:ios|android)\b/,
        /\bvisit [a-z0-9-]+(?: dot |\.)?(?:com|io|co|gg|net|org|app|tv|ai|me|dev|tech|store|shop|games|cloud|xyz|ly|link|site)?\b/,
    ],
    legal: [
        /\bterms and conditions apply\b/,
        /\bmust be 21\+?\b/,
        /\b(?:if you (?:or someone you know )?have|for help with) (?:a )?gambling problem\b/,
        /\bplay responsibly\b/,
        /1-?800-?gambler/,
        /\bconsult (?:your|a) (?:doctor|physician)\b/,
        /\bno purchase necessary\b/,
    ],
    pitch: [
        /\b(?:what|something else that) i (?:really |absolutely )?(?:love|like) about\b/,
        /\bi(?:'ve| have) been (?:using|trying|testing)\b/,
        /\b(?:helps?|lets?|allows?) you\b/,
        /\bhas helped (?:me|us)\b/,
        /\bhelps? (?:with|manage|solve|reduce|avoid)\b/,
        /\ball[- ]in[- ]one (?:solution|platform|suite)\b/,
        /\b(?:solution|platform|software|service) to (?:manage|organize|track|simplify|automate)\b/,
        /\bwithout (?:having to )?(?:switch|pay|spend|hire)\b/,
        /\bin (?:one|a single) (?:platform|place|app|system)\b/,
        /\bchoose (?:which|what|the) (?:apps?|features?|tools?|modules?)\b/,
        /\beasy to (?:manage|scale|use|set up|install|customize|integrate)\b/,
        /\bin one click\b/,
        /\bworks? with (?:android|ios)\b/,
        /\b(?:available|works?|plans?) in (?:more than |over )?\d+ (?:countries|regions)\b/,
        /\bno (?:advanced )?(?:programming|technical knowledge|experience) (?:is )?required\b/,
        /\b24\s*[/ -]?\s*7 (?:live |chat |customer )?support\b/,
        /\bdo you (?:feel|ever feel|struggle with|worry about)\b/,
        /\bimagine (?:being|becoming|having|getting|feeling)\b/,
        /\b(?:experts?|specialists?|professionals?) at\b/,
        /\b(?:personalized|customized|tailored) (?:plan|solution|approach|recommendation)\b/,
        /\bresults speak for themselves\b/,
        /\b(?:five|5)[- ]star reviews?\b/,
        /\bhelped (?:tens of |hundreds of )?thousands of (?:people|customers|clients|businesses)\b/,
        /\b(?:best|easiest|fastest) way to\b/,
        /\b(?:one|another) (?:great|useful|cool) (?:feature|thing)\b/,
        /\b(?:whether you|if you)'?re looking (?:for|to)\b/,
        /\bi (?:absolutely |really )?(?:love|like) (?:this|that|the) (?:feature|tool|service|app|product)\b/,
        /\bworks? by (?:scanning|checking|blocking|protecting|monitoring|encrypting|detecting|filtering)\b/,
        /\b(?:it|this|the (?:app|service|platform|tool|feature|product)) (?:will|can) (?:instantly |automatically )?(?:block|scan|check|protect|prevent|stop|detect|monitor|filter)\b/,
        /\bcertified by (?:independent|leading|trusted) .{0,50}(?:experts?|organizations?|labs?|auditors?)\b/,
        /\b(?:the )?(?:fastest|easiest|most [a-z-]+) .{0,40}\bout there\b/,
    ],
    affiliate: [
        /\baffiliate link\b/,
        /\bi (?:may|might|will) (?:receive|earn|get) (?:a )?(?:commission|percentage)\b/,
        /\bat no (?:extra|additional) cost to you\b/,
        /\busing my (?:link|code) (?:helps|supports) (?:me|the channel|us)\b/,
    ],
};

// regex patterns to detect if a segment is like a sponsor but is actually not one
export const NEGATIVE_PATTERN_GROUPS = {
    explicitNegation: [
        /\b(?:not|isn'?t|wasn'?t|aren'?t|weren'?t) (?:a )?(?:sponsor|sponsored|sponsorship)\b/,
        /\bno sponsor(?:s|ship)?\b/,
        /\bwithout (?:a )?sponsor(?:s|ship)?\b/,
        /\bunsponsored\b/,
    ],
    exampleOrMeta: [
        /\bexample (?:promo|promotional|discount|referral) code\b/,
        /\bthe concept of sponsorship\b/,
        /\b(?:talking|writing|video|story|report|article) about (?:ads|advertising|sponsors|sponsorships)\b/,
        /\bhow (?:promo|discount|referral) codes? work\b/,
        /\bsay(?:ing)? ["']?(?:this video is )?sponsored by\b/,
        /\bsponsored by .{1,60}\b(?:in|back in|during) (?:19|20)\d{2}\b/,
        /\b(?:in|back in|during) (?:19|20)\d{2}.{0,80}\bsponsor(?:ed|ship)?\b/,
        /\b(?:19|20)\d{2}.{0,80}\b(?:was |were )?sponsored by\b/,
        /\b(?:last year|previously|formerly|at the time|back then).{0,80}\bsponsor(?:ed|ship)?\b/,
        /\b(?:phrase|sentence|line|caption|example|script).{0,40}\bsponsored by\b/,
        /\buse code [a-z0-9_-]{2,20} (?:in|as|inside|within|for) (?:the )?(?:config(?:uration)?|source|example|sample|snippet|program|script|file|settings?)\b/,
    ],
    productDiscussion: [
        /\b(?:honest|independent|unsponsored) review\b/,
        /\b(?:reviewing|comparing|testing) (?:the|this|these)\b/,
        /\b(?:scam|suspicious|malicious|fake) (?:link|url|website|promo code)\b/,
        /\b(?:tutorial|lesson|example) (?:about|on|for)\b/,
        /\b(?:news|report) (?:about|on)\b/,
    ],
};

// regex patterns to detect influencer self-promotion
export const SELF_PROMOTION_PATTERNS = [
    /\b(?:my|our) (?:merch|merchandise|store|shop|course|book|app|game|newsletter|patreon|website)\b/,
    /\bcan i (?:do|show|talk about) (?:the |my |our )?merch(?:andise)? now\b/,
    /\bmerch alert\b/,
    /\bsupport (?:this|the|my|our) channel\b/,
    /\bjoin (?:my|our) (?:discord|community|newsletter|patreon)\b/,
    /\bsupport (?:me|us|the channel) (?:on|through|by)\b/,
    /\b(?:buy|get|preorder) (?:my|our) (?:book|course|merch|game|app)\b/,
    /\bchannel membership\b/,
    /\bbecome a (?:member|patron)\b/,
];

// regex patterns to detect third party brand mentions in a sponsor ad
export const THIRD_PARTY_BRAND_PATTERNS = [
    /\b(?:sponsored|sponsoring|presented|supported|brought to you) by\s+([a-z][a-z0-9_-]{2,})\b/i,
    /\b(?:thanks?\s+to|thank\s+you\s+to|thank)\s+([a-z][a-z0-9_-]{2,})\s+for\s+support(?:ing)?\b/i,
    /\b(?:sponsor (?:is|today is)|friends at|partnered with|in partnership with)\s+([a-z][a-z0-9_-]{2,})\b/i,
    /\b(?:go|head) (?:to|over to)\s+([a-z][a-z0-9_-]{2,})\b/i,
];

// set of words that indicate commercial intent
export const STOP_WORDS = new Set(`
    a about above after again against all am an and any are as at be because been
    before being below between both but by can could did do does doing down
    during each few for from further get getting go going had has have having
    he her here hers herself him himself his how i if in into is it its itself
    just let like may me more most my myself no nor not now of off on once only
    or other our ours ourselves out over own same she should so some such than
    that the their theirs them themselves then there these they this those
    through to too under until up very was we were what when where which while
    who whom why will with would you your yours yourself yourselves
`.trim().split(/\s+/));

// set of words that indicate commercial intent
export const COMMERCIAL_WORDS = new Set(`
    sponsor sponsored sponsoring sponsorship partner partnership promo promotional
    code discount offer link description bio trial free percent sale website
    app download install signup sign subscribe today video episode channel
    support supporting thanks thank use using click check visit
`.trim().split(/\s+/));

// blocklist for brand mentions
export const BRAND_BLOCKLIST = new Set([
    ...STOP_WORDS,
    ...COMMERCIAL_WORDS,
    "com", "www", "http", "https", "people", "thing", "things", "way",
    "first", "best", "great", "really", "also", "even", "much", "make",
    "example", "tutorial", "lesson", "review", "fake", "independent",
    "course", "newsletter", "member", "membership", "merch", "merchandise",
    "store", "shop", "community", "patreon", "book",
]);
