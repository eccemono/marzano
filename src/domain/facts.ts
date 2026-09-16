/**
 * Tomato facts, shown one per break.
 *
 * The list is data, not logic, so it lives here as a plain array and the
 * selection rules stay in the timer/embed layer where they can be tested.
 *
 * One line each, and no two entries restate the same fact - that is the whole
 * point of the list. Order here is the canonical order; each session shuffles it
 * with its own seed, so two sessions never show the same sequence of facts.
 */

export const TOMATO_FACTS: readonly string[] = [
  'The word "tomato" traces back to "tomatl," a word from Nahuatl, the language of the Aztecs.',
  'The Aztecs had a specific word, "xitomatl," for the red tomato, and a version of that word is still used in Mexico today.',
  'In Italy, the tomato is called "pomodoro," which literally means "golden apple."',
  'The "golden apple" name stuck because the first tomatoes to reach Italy were yellow, not red.',
  'The tomato\'s official scientific name includes "lycopersicum," a Latin word meaning "wolf peach."',
  'The French once called tomatoes "pommes d\'amour" ("apples of love") because they thought the fruit was an aphrodisiac.',
  'In old English, tomatoes were sometimes called "love apples."',
  'Germans named the tomato "Paradiesapfel," meaning "apple of paradise."',
  'In Chinese, the tomato\'s name (fānqié, 番茄) literally means "foreign eggplant."',
  'The English word "tomato" was likely reshaped to rhyme with "potato," an earlier New World crop.',
  "Botanically speaking, a tomato is a fruit, and more specifically a berry.",
  "Tomatoes belong to the nightshade family, the same plant group as potatoes, eggplants, and tobacco.",
  "Bell peppers and eggplants are close relatives of the tomato.",
  "Tomatoes and potatoes are so closely related that scientists have cross-bred them in the lab.",
  "Tobacco and tomatoes are both nightshades, which is part of why people once feared the tomato.",
  "About 95% of a tomato is just water.",
  "In the wild, tomatoes are tiny, only about the size of a pea.",
  "Tomato plants are actually vines that can climb more than 3 metres (10 feet) high.",
  'Some tomato plants (called "indeterminate") keep growing and fruiting until the first frost kills them.',
  'Other tomatoes (called "determinate") grow as a bush and ripen all their fruit at once.',
  "In a frost-free climate, one tomato vine can grow 10 to 15 feet in a single season.",
  "Tomato stems and leaves are covered in tiny sticky hairs that help defend the plant against insects.",
  'Tomato stem hairs release a sticky, sugary goo that gardeners call "tomato tar."',
  "A tomato stem's tiny hairs can turn into roots wherever the vine touches damp soil.",
  "Tomato leaves have a strong, unmistakable smell that comes from natural oils in the plant.",
  "Tomato flowers are small, yellow, and shaped like stars.",
  "A tomato flower pollinates itself because it holds both male and female parts.",
  "A tomato often pollinates itself even before its flower has fully opened.",
  "Since tomatoes self-pollinate, a single plant on a sunny balcony can still produce fruit.",
  'Bumblebees help pollinate tomatoes by shaking the flowers, a trick called "buzz pollination."',
  "A tomato keeps ripening even after you have picked it off the vine.",
  "Tomatoes turn red thanks to a natural gas called ethylene, which triggers the ripening process.",
  "The rich red color of a tomato comes from a pigment called lycopene.",
  "Lycopene's real purpose is to catch the eye of animals, who eat the fruit and scatter its seeds.",
  "In very hot weather, tomatoes stop ripening and may stay green.",
  "Unripe green tomatoes contain a mildly toxic compound called tomatine, which is why they are usually cooked first.",
  "Tomato leaves and stems are genuinely poisonous and should never be eaten.",
  "You would need to eat over half a kilogram of tomato leaves to reach a harmful dose.",
  "Tomato plants are perennials by nature, but gardeners usually grow them as one-season annuals.",
  "In warm tropical climates, a tomato plant can live for years and keep fruiting.",
  "A tomato plant has more genes (about 35,000) than a human being (about 20,000 to 25,000).",
  "A single tomato can hold anywhere from 150 to 300 seeds.",
  "Each tomato seed sits in a jelly-like coating that stops it from sprouting inside the fruit.",
  'The green "shoulders" on some heirloom tomatoes are totally normal, not a sign of being unripe.',
  "One tomato hornworm caterpillar can devour an entire tomato plant on its own.",
  "Tomato hornworms eventually turn into big moths that resemble hummingbirds.",
  "Tomatoes are in the same plant family as petunias.",
  "Tomatoes are warm-weather plants that cannot survive a frost.",
  "Tomato plants need plenty of direct sunlight to ripen their fruit properly.",
  "Tomato plants begin flowering just a few weeks after they are planted.",
  "Tomatoes can be grown without soil at all, using hydroponics (nutrient-rich water).",
  "A tomato turns red as its green chlorophyll fades and the pigment lycopene builds up.",
  "Gardeners plant tomato seedlings extra-deep because the buried stem will grow extra roots.",
  'Tomato plants are "heavy feeders" that need rich, well-fed soil to produce well.',
  "A sunken brown patch on a tomato's bottom (blossom-end rot) is caused by a calcium shortage, not a bug.",
  "It takes roughly 45 to 60 days for a tomato flower to become a ripe fruit.",
  "A single ripe tomato contains more than 400 different aroma compounds that together create its flavor.",
  "Tomato plants give off a stronger scent when you brush against their leaves.",
  "Tomatoes are mildly acidic, with a pH of around 4.",
  "A tomato's skin is more packed with nutrients than the flesh inside.",
  "Commercial growers sometimes graft tomato plants onto tougher rootstock for a stronger crop.",
  "One healthy tomato plant can produce 10 to 15 pounds of fruit in a single season.",
  "If temperatures drop too low, tomato flowers may fall off without ever setting fruit.",
  "With enough light, tomato plants can be grown indoors year-round.",
  "The pigment that makes tomatoes red, lycopene, is also what colors watermelon and pink grapefruit.",
  "Late blight, the disease that caused the Irish potato famine, attacks tomato plants too.",
  "Tomatoes are native to the Andes mountains in western South America.",
  "Even though tomatoes came from South America, they were first domesticated in Mexico.",
  "People have been growing tomatoes for about 7,000 years.",
  "By 500 BCE, farmers in southern Mexico were already cultivating tomatoes.",
  "The Aztecs and their neighbors turned the wild tomato into the garden vegetable we know today.",
  "A Spanish friar in the 1500s wrote that Aztec markets sold tomatoes in many colors and shapes.",
  "The first tomatoes Europeans ever saw were small and yellow, nothing like modern red ones.",
  "Wild tomatoes still grow today on the dry slopes of the Andes.",
  "Spanish explorers first carried the tomato to Europe in the 1500s.",
  "Tomatoes were already being grown in Europe by the 1540s, shortly after the conquest of Mexico.",
  "The first European to write about the tomato was an Italian botanist named Pietro Andrea Mattioli, in 1544.",
  "Mattioli initially mistook the tomato for a new variety of eggplant.",
  "The Spanish took tomatoes to their colonies in the Caribbean and the Philippines.",
  "From the Philippines, tomatoes spread throughout Asia.",
  "Tomatoes reached China in the 1500s, most likely by way of the Philippines or Macau.",
  "Tomatoes arrived in Japan in the 1600s, brought by Portuguese traders.",
  "At first, Europeans grew tomatoes as ornaments, not as food.",
  "In Florence, tomatoes served as table decorations long before they became dinner.",
  "The earliest known cookbook with tomato recipes was published in Naples in 1692.",
  "Italy's first tomato recipes were actually borrowed from Spanish cooks.",
  "Italy did not truly embrace the tomato until the 17th or 18th century.",
  "Pasta with tomato sauce only became common in Italy in the 1800s.",
  "The first tomatoes recorded in British North America turned up in South Carolina in 1710.",
  "Thomas Jefferson ate tomatoes in Paris and mailed seeds back to America to grow them.",
  "Tomatoes were growing at George Washington's Mount Vernon estate by the 1790s.",
  "Tomatoes only became common in American kitchens after the Civil War.",
  "The rise of home canning in the 1800s turned tomatoes into a year-round food.",
  'Tomatoes are among the "New World" foods, like corn, beans, and potatoes, that transformed cooking worldwide.',
  "For roughly 200 years, many Europeans were convinced that tomatoes were poisonous.",
  'In the 1700s, the tomato earned the nickname "poison apple."',
  "The fear grew because tomatoes resemble deadly nightshade, a famously toxic plant.",
  "Tomatoes are related to mandrake, a plant long associated with poison and witchcraft.",
  "Wealthy Europeans ate off pewter plates, dishes made from a soft metal that contains lead.",
  "Tomato acid leached lead out of pewter plates and into the food, causing lead poisoning.",
  "Since only the rich (with their pewter plates) fell ill, the tomato unfairly took the blame.",
  "Poorer people, who ate off wooden plates, enjoyed tomatoes with no problems at all.",
  "In parts of Europe, people once believed that eating tomatoes could turn you into a werewolf.",
  "The French were wary of tomatoes, yet also believed the fruit worked as an aphrodisiac.",
  "Legend says a man ate a tomato on a New Jersey courthouse's steps in 1820 to prove it was not deadly.",
  'In the 1830s, a doctor peddled "tomato pills" as a cure-all, though they barely contained any real tomato.',
  "Long before they were a staple food, tomatoes were sold as medicine.",
  "Tomatoes are the single biggest source of the antioxidant lycopene in most people's diets.",
  "The lycopene in tomatoes has been linked to a lower risk of heart disease and certain cancers.",
  "Cooking tomatoes actually makes their lycopene easier for your body to absorb.",
  "Eating tomatoes with a little fat, like olive oil, helps your body absorb even more lycopene.",
  "Processed tomato products like ketchup and paste contain far more of the antioxidant lycopene than fresh tomatoes.",
  "Ketchup packs roughly 10 times more of the antioxidant lycopene per gram than a raw tomato.",
  "One medium tomato supplies about a quarter of your daily vitamin C.",
  "In one study, people who ate tomato paste with olive oil for 10 weeks got 40% fewer sunburns.",
  "Tomatoes contain vitamins A, C, E, and K.",
  "Tomatoes are naturally cholesterol-free and almost fat-free.",
  "Being 95% water, tomatoes are a refreshing, hydrating snack.",
  "A tomato's flavor comes from the balance between its natural sugars and acids.",
  "Tomatoes contain a compound called chlorogenic acid that may help lower blood pressure.",
  "Tomatoes are a good source of potassium, a mineral important for heart and muscle health.",
  "The beta-carotene in tomatoes gives you vitamin A, which supports healthy eyes and skin.",
  "Tomatoes are rich in folate, a B vitamin that helps your cells grow and divide.",
  "Tomatoes also supply vitamin K, which helps your blood clot properly.",
  "Lycopene, the red pigment in tomatoes, is fat-soluble, meaning it absorbs best with a little fat.",
  "Sun-drying tomatoes is an old Mediterranean way to preserve the fruit for winter.",
  "Sun-drying concentrates a tomato's natural sugars, making it noticeably sweeter.",
  "Tomato juice became a trendy health drink in the early 1900s.",
  "The classic Bloody Mary cocktail is built on tomato juice.",
  "The Bloody Mary cocktail is thought to have been invented in Paris in the 1920s.",
  "Gazpacho is a chilled tomato soup that originated in Spain.",
  "V8 vegetable juice is mostly tomato juice.",
  'Mixing tomato juice with clam broth creates "Clamato," a popular drink on its own.',
  "The heaviest tomato ever grown weighed 7.66 kg (16.89 lb), heavier than a bowling ball.",
  "Dan Sutherland grew the world's heaviest tomato, weighing 16.89 pounds, in Walla Walla, Washington in 2025.",
  "Dan Sutherland became the first person ever to grow a tomato weighing more than 10 pounds.",
  "For over 25 years, the world's heaviest-tomato record sat at just 3.51 kg (about 7 lb 12 oz).",
  "The most tomatoes ever grown on a single plant is 5,891.",
  "A tomato tree at Disney World's Epcot once produced 32,194 tomatoes in a single year.",
  "The 32,194-tomato harvest from Disney's Epcot tomato tree weighed over 1,150 pounds.",
  "Disney's giant Epcot tomato tree was originally discovered in Beijing, China, and takes about 18 months to reach full size.",
  "A British gardener broke the single-stem tomato record three times, going from 488 to 839 to 1,269 fruits.",
  "One world-record tomato grower credited his success partly to praying next to his plant.",
  'A giant tomato can form from a "megabloom," which happens when several flowers fuse into one.',
  'The "Ruby Roman" tomato, a luxury Japanese variety, has sold for more than $400 for a single fruit.',
  'The "Big Boy" tomato, a beloved garden classic, was introduced in 1949.',
  "More than 10,000 different varieties of tomato exist around the world.",
  "Tomatoes come in red, yellow, orange, pink, purple, black, green, white, and even striped.",
  '"Blue" tomatoes like Indigo Rose get their color from the same pigments that color blueberries.',
  "White tomatoes really exist, with flesh that is almost colorless.",
  'The "Garden Peach" tomato has fuzzy skin, just like a peach.',
  "Fuzzy yellow tomatoes like Garden Peach are more closely related to wild tomatoes than red ones are.",
  'Tomatoes range from pea-sized "currant" types up to beefsteaks weighing over 2 pounds.',
  "Beefsteak tomatoes are the giants, bred for slicing onto sandwiches and burgers.",
  'The "beefsteak" name comes from the tomato\'s meaty, dense texture.',
  "Paste tomatoes like Roma and San Marzano are dense and fleshy, perfect for making sauce.",
  "Cherry tomatoes are small, sweet, and grow in big clusters.",
  "Grape tomatoes are tiny and oval, named for their resemblance to grapes.",
  "The Brandywine heirloom, famous for its flavor, dates back to 1885.",
  "Cherokee Purple tomatoes were reportedly passed down by the Cherokee people for over a century.",
  '"Mortgage Lifter" tomatoes earned their name because a Depression-era farmer sold enough to pay off his home loan.',
  "The Black Krim tomato is named after the Crimean peninsula near the Black Sea.",
  "Heirloom tomatoes are open-pollinated, meaning you can save their seeds and regrow the same variety.",
  '"Heirloom" usually refers to an old, open-pollinated tomato variety from before World War II.',
  "San Marzano tomatoes must be grown in a specific region of Italy to legally carry that name.",
  "The Roma tomato is named after the city of Rome.",
  "Grocery-store tomatoes are bred with thick skins so they can survive long truck journeys.",
  "Many supermarket tomatoes are picked green and later exposed to ethylene gas to turn them red.",
  "Green Zebra is a tomato that stays green with stripes even when fully ripe.",
  '"Sun Gold" is a famously sweet orange cherry tomato.',
  "Some tomato varieties are meant to be eaten when ripe and green, not red.",
  "Campari tomatoes were bred specifically for extra sweetness.",
  "A cluster of tomatoes growing together on one stem is called a truss.",
  '"Vine-ripened" tomatoes are often sold still attached to the vine.',
  "Tomato cages and stakes keep the vines off the ground so the fruit does not rot.",
  "Tomatoes are the best-selling vegetable seed among home gardeners.",
  "You can scoop seeds from a ripe tomato, dry them, and plant them the next season.",
  "La Tomatina is a Spanish festival where an entire town pelts each other with tomatoes.",
  "La Tomatina is widely considered the world's biggest food fight.",
  "La Tomatina takes place every year on the last Wednesday of August in the town of Buñol, Spain.",
  "La Tomatina began in 1945 when a spontaneous food fight broke out during a local parade.",
  "La Tomatina reportedly started when someone grabbed a tomato from a market stall and threw it.",
  "Spain's dictator Francisco Franco banned La Tomatina in the 1950s.",
  'To protest the ban, townspeople staged a mock "tomato funeral," parading a giant tomato in a coffin.',
  "The tomato-funeral protest worked, and Franco brought the festival back in 1957.",
  "Around 145,000 kg (320,000 lb) of tomatoes are thrown at La Tomatina every year.",
  "La Tomatina is capped at 20,000 ticketed participants.",
  "La Tomatina officially begins when someone knocks a ham off the top of a greased pole.",
  "The tomato-throwing battle at La Tomatina lasts about one hour.",
  "At La Tomatina, only squashed tomatoes may be thrown, so nobody gets hurt.",
  "The citric acid in the tomatoes actually leaves Buñol's streets cleaner than before the festival.",
  "The tomatoes used at La Tomatina are overripe ones that would otherwise go to waste.",
  "Ketchup began as a fish sauce, not a tomato sauce.",
  'The word "ketchup" comes from "kê-tsiap," a Chinese (Hokkien) word for a fermented fish sauce.',
  "Early ketchups were made from mushrooms, walnuts, oysters, or anchovies, and contained no tomatoes.",
  "Mushroom ketchup was reportedly a favorite of the novelist Jane Austen.",
  "The first published tomato ketchup recipe appeared in 1812.",
  "The original 1812 tomato ketchup was made with brandy but no vinegar or sugar.",
  "The Heinz company started selling ketchup in 1876.",
  'The famous "57 varieties" on a Heinz bottle was simply a number the founder liked the sound of.',
  "Ketchup is thick in the bottle but pours easily once you shake it.",
  "By 1907, Heinz was producing 12 million bottles of ketchup a year.",
  "Ketchup was once sold as a medicine, long before it became a condiment.",
  "In 1893, the U.S. Supreme Court officially declared that a tomato is a vegetable.",
  "The U.S. Supreme Court's logic was that tomatoes are served with dinner, not dessert, so they are vegetables.",
  "The 1893 tomato ruling came about because a vegetable import tax was at stake.",
  "The European Union took the opposite view in 2001, ruling that tomatoes are fruit.",
  "The tomato is the official state fruit of Ohio.",
  "The tomato is the official state fruit of Tennessee.",
  "The tomato is the official state vegetable of New Jersey.",
  "Arkansas made the tomato both its official state fruit and its official state vegetable.",
  "Tomato juice is the official state beverage of Ohio.",
  "A tomato is, all at once, a berry, a fruit, and (in the kitchen) a vegetable.",
  "Tomatoes have been successfully grown to fruit aboard the International Space Station.",
  'NASA grew "Red Robin" dwarf tomatoes in space in 2022 and 2023.',
  "The space tomatoes were grown in pouches filled with porous ceramic instead of soil.",
  "NASA is studying whether growing tomatoes in space could feed astronauts and lift their spirits.",
  "Astronaut Frank Rubio once lost two tomatoes in space, and they turned up nearly a year later.",
  "The lost space tomatoes were found dehydrated and slightly squished, but not rotten.",
  "Tomatoes grown in space sprouted extra roots right out of their stems.",
  "NASA flew millions of tomato seeds into space in 1984 to see how they would grow afterward.",
  "China grows roughly a third of all the tomatoes on Earth.",
  "The world grows more than 180 million tonnes of tomatoes every year.",
  "The world's tomato fields span over 5 million hectares, which is about 7 million football fields.",
  "The tomato is the most valuable vegetable crop grown anywhere in the world.",
  "Among vegetables, only the potato outranks the tomato in global production.",
  "Worldwide tomato production has roughly tripled since the year 2000.",
  "The average American eats the equivalent of about 90 pounds of tomatoes a year, mostly as sauce and ketchup.",
  "Tomato paste, purée, sauce, and juice all come from the exact same fruit.",
  "The tomato is the most popular crop grown in American home gardens.",
  "About 93% of American gardening households grow tomatoes.",
  "Americans eat more tomatoes than almost any other vegetable, and only potatoes beat them.",
  "Pizza is one of the biggest reasons tomatoes became popular worldwide.",
  "The red tomato, white mozzarella, and green basil on a Margherita pizza mirror the Italian flag.",
  "Pizza Margherita is said to have been created in 1889 for Queen Margherita of Italy.",
  "The 1889 queen story is probably a marketing myth, but pizza Margherita is a genuine classic.",
  "Joseph Campbell launched condensed tomato soup in 1897 and built an empire on canned tomatoes.",
  "Tomatoes are acidic enough to eat through aluminum foil, leaving a metallic taste.",
  "Fried green tomatoes became famous through a novel and a film of the same name.",
  'A 1978 comedy-horror B-movie called "Attack of the Killer Tomatoes" poked fun at the fruit.',
  'The tomato was the first genetically engineered food ever sold in stores (the "Flavr Savr," in 1994).',
  "The Flavr Savr tomato was a commercial flop despite being the first genetically engineered food.",
  'A genetically modified "purple tomato" packed with antioxidants is now sold in the UK.',
  "Japan sells a gene-edited tomato bred to be rich in GABA, a compound linked to calmness.",
  'Tomatillos, the green, paper-husked "tomatoes" in salsa verde, are actually a different plant.',
  'Early English writers sometimes called the tomato the "wolf\'s peach."',
  "In early 1800s England, audiences threw tomatoes at performers they did not like.",
  "The town of Parma, Italy is home to a museum devoted entirely to the tomato.",
  "Tomatoes are best kept at room temperature, because refrigeration dulls their flavor.",
  "Tomato paste was invented as a way to concentrate and preserve the harvest.",
  "The tomato is now a defining symbol of Italian and Mediterranean cooking.",
  'The phrase "you say tomato, I say tomato" jokes about the fruit\'s two accepted pronunciations.',
  "Tomato leaves were once used as a homemade insect repellent.",
  'The Pomodoro Technique is the official time-management method created by Francesco Cirillo, and "pomodoro" is the Italian word for tomato.',
  "The Pomodoro Technique was invented in the late 1980s by an Italian named Francesco Cirillo.",
  "Francesco Cirillo invented the Pomodoro Technique while he was a university student struggling to concentrate.",
  "The Pomodoro Technique is named after the tomato-shaped kitchen timer that its creator, Francesco Cirillo, used as a student.",
  'The very first "pomodoro" ever was a bet Francesco Cirillo made with himself to study for just 10 minutes without distraction.',
  "Francesco Cirillo, creator of the Pomodoro Technique, failed his first 10-minute study session, but he kept at it until he could focus.",
  'In the Pomodoro Technique, one "pomodoro" is 25 minutes of focused work followed by a 5-minute break.',
  "The Pomodoro Technique says to take a longer break of 15 to 30 minutes after every four 25-minute work sessions.",
  "The Pomodoro Technique's 25-minute work sessions came partly from old kitchen timers, which often maxed out at 30 minutes.",
  "In the Pomodoro Technique, a 25-minute work session cannot be split in half.",
  "In the Pomodoro Technique, if you are interrupted during a 25-minute work session, you void it and start over.",
  'In the Pomodoro Technique, one 25-minute work session is called a "pomodoro," and the plural is "pomodori."',
  "Francesco Cirillo formally wrote down the Pomodoro Technique in 1992.",
  "Francesco Cirillo began teaching the Pomodoro Technique to individuals in 1998 and to teams in 1999.",
  "Francesco Cirillo first published the Pomodoro Technique as a free PDF in 2006, and it was downloaded over 2 million times.",
  "The Pomodoro Technique spread first among software developers before going mainstream.",
  "The full Pomodoro Technique is more than a timer, and it includes planning tasks, tracking effort, and reviewing your work.",
  "A core idea of the Pomodoro Technique is to treat time as an ally rather than an enemy.",
  "Francesco Cirillo chose 25 minutes because it was long enough to get real work done but short enough to stay focused.",
  'The tomato-shaped timer that inspired the Pomodoro Technique is still sold today as a "Pomodoro Classic Timer."',
  "Francesco Cirillo, the creator of the Pomodoro Technique, runs a consulting firm based in Berlin.",
  "The Pomodoro Technique's five daily stages are planning, tracking, recording, processing, and visualizing.",
];

/** How many facts are available. */
export const TOMATO_FACT_COUNT = TOMATO_FACTS.length;

/**
 * A tiny, deterministic PRNG.
 *
 * The point of seeding rather than using `Math.random()` per break is that the
 * whole session's sequence is fixed the moment it starts: the same seed always
 * produces the same playlist, which is what makes the behaviour testable, and a
 * per-session seed is what makes two sessions differ.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Fisher-Yates, driven by {@link mulberry32}. Never mutates its input. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const output = [...items];
  const random = mulberry32(seed);

  for (let index = output.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const held = output[index] as T;
    output[index] = output[swap] as T;
    output[swap] = held;
  }

  return output;
}

/**
 * The fact for the `breakOrdinal`-th break of a session (1-based).
 *
 * The ordinal is the count of focus periods completed, which is exactly how many
 * breaks have been entered, so consecutive breaks walk a shuffled playlist
 * without ever repeating - and a session longer than the list simply reshuffles
 * with the next cycle's seed rather than starting over identically.
 */
export function factForBreak(seed: number, breakOrdinal: number): string {
  const total = TOMATO_FACTS.length;
  if (total === 0) return "";

  const zeroBased = Math.max(0, Math.floor(breakOrdinal) - 1);
  const cycle = Math.floor(zeroBased / total);
  const position = zeroBased % total;

  return seededShuffle(TOMATO_FACTS, seed + cycle)[position] ?? "";
}

/** A fresh per-session seed. */
export function newFactSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}
