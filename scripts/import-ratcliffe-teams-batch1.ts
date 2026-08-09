import { log, main } from './_cli';
import { writeTeamProfiles, type TeamProfileInput } from '../src/lib/sync/analyst-profiles';

const EDITION = '2026-process-guide';
const SEASON = '2026';
const SOURCE = 'jeff-ratcliffe';

const TEAMS: TeamProfileInput[] = [
  {
    teamId: 'ARI',
    outlook:
      "Arizona hits the reset button heading into 2026 after last season completely unraveled. Jonathan Gannon was fired following a 3-14 collapse, and the Cardinals brought in Mike LaFleur to rebuild an offense that averaged just 20.9 points per game while giving up 59 sacks. Kyler Murray was traded to Minnesota, leaving Jacoby Brissett and rookie Carson Beck competing for the starting job. The front office immediately focused on upgrading the offensive line, highlighted by second-round guard Chase Bisontis. Marvin Harrison Jr. showed flashes but injuries limited him to 41 catches in 12 games. Trey McBride became the centerpiece of the passing game with 126 receptions and 1,239 yards, while third overall pick Jeremiyah Love gives the offense a dynamic new weapon.",
    bestStacks: ['Trey McBride + Jacoby Brissett', 'Marvin Harrison Jr. + Jacoby Brissett', 'Michael Wilson + Jacoby Brissett'],
    players: [
      {
        name: 'Jeremiyah Love',
        position: 'RB',
        archetype: 'BOOM/BUST FEATURE RB',
        narrative:
          "Dynamic 3-down weapon with the explosiveness to turn any touch into a house call. Love's ceiling is massive if the Cardinals offense takes a step forward, especially with his big play ability creating weekly upside. His ceiling is high, but the Arizona offense could cap his production. (Rookie, R1.)",
      },
      {
        name: 'Marvin Harrison Jr.',
        position: 'WR',
        archetype: 'HIGH CEILING WR3',
        narrative:
          'Talented outside receiver still searching for his footing as a pro after a disappointing, injury-shortened second season. Harrison has the size, length, and pedigree of a true X, but he needs better health and a steadier quarterback situation to reach his ceiling. 2025: 41 rec, 608 yds, 4 TD, 18.0% target share, 10.5 FPTS/GM.',
      },
      {
        name: 'Michael Wilson',
        position: 'WR',
        archetype: 'VOLUME-DEPENDENT WR4',
        narrative:
          "Dependable target who took a real step forward in 2025, though much of his production came with Harrison sidelined. Wilson lives on shorter, lower-air-yards targets, which caps his ceiling and makes him vulnerable to a volume dip if Harrison returns to form. 2025: 78 rec, 1006 yds, 7 TD, 20.4% target share, 13.0 FPTS/GM.",
      },
      {
        name: 'Trey McBride',
        position: 'TE',
        archetype: 'ELITE TE',
        narrative:
          "Elite, target-hog tight end who finished as the TE1 in fantasy last season and profiles as a weekly cornerstone again in 2026. McBride's blend of volume, route tree, and red-zone usage gives him both an enormous ceiling and as safe a floor as any non-WR in the league. 2025: 126 rec, 1239 yds, 11 TD, 27.4% target share, 18.6 FPTS/GM.",
        impact: 'HIGH',
      },
      { name: 'Jacoby Brissett', position: 'QB', archetype: 'SUPERFLEX DEPTH', narrative: 'Flashed upside last year, but is only a bridge option for the Cardinals.', impact: 'LOW' },
      { name: 'Tyler Allgeier', position: 'RB', archetype: 'HANDCUFF', narrative: "A quality backup with RB2 potential if he's called on for lead back duties.", impact: 'LOW' },
      { name: 'Kendrick Bourne', position: 'WR', archetype: 'OFF THE RADAR', narrative: "He's popped on occasion but has never strung together consistency.", impact: 'LOW' },
      { name: 'Carson Beck', position: 'QB', archetype: 'MONITOR IN SUPERFLEX', narrative: 'Drafted in the 3rd round, he has a chance to surface at some point. (Rookie.)', impact: 'LOW' },
    ],
  },
  {
    teamId: 'ATL',
    outlook:
      'Atlanta enters 2026 with a completely new power structure after last season fell flat. Kevin Stefanski takes over as head coach with Tommy Rees running the offense and Ian Cunningham stepping in as GM following the dismissal of Raheem Morris and his staff. The quarterback situation got interesting after the addition of Tua Tagovailoa, who\'ll battle Michael Penix Jr. as he works back from a knee injury. Bijan Robinson is still the engine of this offense after erupting for 1,478 rushing yards, especially now that Tyler Allgeier is gone. Drake London flashed WR1 upside before injury, Kyle Pitts remains stuck in trade speculation, and Jawaan Taylor was brought in to stabilize the offensive line. Expect Stefanski to lean heavily on the ground game and play-action.',
    bestStacks: ['Drake London + Tagovailoa/Penix', 'Bijan Robinson + Tagovailoa/Penix', 'Kyle Pitts + Tagovailoa/Penix'],
    players: [
      {
        name: 'Bijan Robinson',
        position: 'RB',
        archetype: 'ELITE RB',
        narrative:
          "Workhorse three-down back and the unquestioned engine of Atlanta's offense, coming off a top-2 fantasy finish at the position. Robinson combines elite contact balance, breakaway speed, and rare receiving chops, giving him a complete profile that few backs in the league can match. 2025: 1478 rush yds, 7 rush TD, 820 rec yds, 4 rec TD, 22.0 FPTS/GM.",
        impact: 'HIGH',
      },
      {
        name: 'Kyle Pitts',
        position: 'TE',
        archetype: 'HIGH CEILING TE',
        narrative:
          "Freakish athlete with rare size-speed traits who finally flashed the ability Atlanta drafted him for, leading the team in receiving yards in 2025. Pitts still carries volatility and is on the franchise tag, but the upside and matchup nightmare potential are undeniable. 2025: 88 rec, 928 yds, 5 TD, 22.7% target share, 12.4 FPTS/GM.",
      },
      {
        name: 'Tua Tagovailoa',
        position: 'QB',
        archetype: 'NON-MOBILE PASSER',
        narrative:
          "Highly accurate, rhythm-based passer when the pocket is clean, but his game falls off sharply under pressure and durability remains a concern. Tua projects as the Week 1 starter, bringing a conservative style that fits Stefanski's run-leaning approach. 2025: 2660 pass yds, 20 pass TD, 43 rush yds, 12.6 FPTS/GM.",
      },
      {
        name: 'Drake London',
        position: 'WR',
        archetype: 'ALPHA WR',
        narrative:
          'Big-bodied, physical X receiver who wins with size, contested catches, and strong hands rather than separation speed. London was on a career-best trajectory in 2025 before a knee injury cost him several games, and he enters 2026 as Atlanta\'s clear, unquestioned WR1. 2025: 68 rec, 919 yds, 7 TD, 30.4% target share, 16.8 FPTS/GM.',
        impact: 'HIGH',
      },
      { name: 'Brian Robinson Jr.', position: 'RB', archetype: 'HANDCUFF', narrative: "Was once an RB2 candidate, but he's now relegated to a backup role.", impact: 'LOW' },
      { name: 'Michael Penix Jr.', position: 'QB', archetype: 'MONITOR IN SUPERFLEX', narrative: 'Returning from an ACL injury and will have to battle to get his job back.', impact: 'LOW' },
      { name: 'Jahan Dotson', position: 'WR', archetype: 'OFF THE RADAR', narrative: "The former first round pick hasn't hit at either of his previous two stops.", impact: 'LOW' },
      { name: 'Zachariah Branch', position: 'WR', archetype: 'MONITOR IN DEEP LEAGUES', narrative: 'A speedy rookie who thrives as a YAC receiver with short air yards targets.', impact: 'LOW' },
    ],
  },
  {
    teamId: 'BAL',
    outlook:
      "Baltimore looks very different heading into 2026 after an 8-9 season snapped the team's playoff streak. John Harbaugh is gone after 18 years, with former Chargers DC Jesse Minter taking over as head coach. The offense also gets a new voice with 30-year-old Declan Doyle stepping in as the league's youngest play-caller after Todd Monken left for Cleveland. Lamar Jackson returns after battling injuries throughout last season, and the offense never came close to recapturing its dominant 2024 form. The Ravens still want to bully teams on the ground after finishing second in rushing behind Derrick Henry's 1,595-yard campaign, while Zay Flowers continued his rise with 1,211 receiving yards. Up front, the loss of Tyler Linderbaum creates concern heading into the season.",
    bestStacks: ['Zay Flowers + Lamar Jackson', 'Mark Andrews + Lamar Jackson'],
    players: [
      {
        name: 'Derrick Henry',
        position: 'RB',
        archetype: 'HIGH VOLUME RB',
        narrative:
          "Bruising bell cow who remains a force at the goal line and in the open field, coming off a 1,595-yard rushing season. Henry's blend of size, contact balance, and breakaway speed is rare for his frame, though his age and heavy career workload are worth monitoring as he enters 2026. 2025: 1595 rush yds, 16 rush TD, 150 rec yds, 16.8 FPTS/GM.",
      },
      {
        name: 'Zay Flowers',
        position: 'WR',
        archetype: 'HIGH CEILING WR2',
        narrative:
          "Big-play threat who is firmly the centerpiece of Baltimore's passing attack. Flowers is a nightmare after the catch and a constant deep threat, but his potential can be limited by Baltimore's run-first lean and the lack of a proven complementary target. 2025: 82 rec, 1211 yds, 5 TD, 29.0% target share, 14.7 FPTS/GM.",
        impact: 'HIGH',
      },
      {
        name: 'Mark Andrews',
        position: 'TE',
        archetype: 'TD-DEPENDENT TE',
        narrative:
          "Boom-or-bust veteran whose value leans heavily on touchdowns, making his production maddeningly inconsistent. Now 31 and coming off a reduced role, Andrews can still flash as a red-zone target, but without scores his floor is low. 2025: 48 rec, 422 yds, 5 TD, 17.2% target share, 7.7 FPTS/GM.",
      },
      {
        name: 'Lamar Jackson',
        position: 'QB',
        archetype: 'MOBILE QB1',
        narrative:
          "Dual-threat superstar and two-time MVP who remains one of the league's most dangerous players when healthy. Jackson battled a string of nagging injuries throughout 2025 that sapped the offense's rhythm, and he now adjusts to a new coaching staff and the NFL's youngest play-caller in 2026. 2025: 2549 pass yds, 21 pass TD, 349 rush yds, 2 rush TD, 17.4 FPTS/GM.",
        impact: 'HIGH',
      },
      { name: 'Justice Hill', position: 'RB', archetype: 'LIMITED VOLUME PASS CATCHER', narrative: "Change-of-pace back who occasionally pops but isn't consistent.", impact: 'LOW' },
      { name: 'Rashod Bateman', position: 'WR', archetype: 'OFF THE RADAR', narrative: "He'll have a random spike week but is generally nonexistent.", impact: 'LOW' },
      { name: 'Elijah Sarratt', position: 'WR', archetype: 'MONITOR IN DEEP LEAGUES', narrative: 'Promising rookie who could work his way into a larger role in the slot.', impact: 'LOW' },
      { name: "Ja'Kobi Lane", position: 'WR', archetype: 'MONITOR IN DEEP LEAGUES', narrative: 'Big-bodied rookie who is worth keeping an eye on in case he pops.', impact: 'LOW' },
    ],
  },
  {
    teamId: 'BUF',
    outlook:
      "Buffalo keeps the core of one of the league's best offenses intact, but there's still major change heading into 2026. Joe Brady takes over as head coach after Sean McDermott's nine-year run ended, while Pete Carmichael arrives after spending years alongside Sean Payton in New Orleans. Josh Allen remains the centerpiece after throwing for 3,668 yards and adding 14 rushing touchdowns in 2025, though his offseason recovery from foot surgery bears watching. The Bills finished fourth in scoring and third in total offense behind James Cook's 1,621 rushing yards. DJ Moore gives the receiving corps another proven weapon and already appears to be developing chemistry with Allen. The bigger concern is an offensive line that lost Connor McGovern and David Edwards.",
    bestStacks: ['DJ Moore + Josh Allen', 'Khalil Shakir + Josh Allen', 'Dalton Kincaid + Josh Allen'],
    players: [
      {
        name: 'James Cook',
        position: 'RB',
        archetype: 'HIGH VOLUME RB',
        narrative:
          "Explosive back who took on a true workhorse role in 2025 and rewarded it with 1,621 rushing yards. Cook pairs breakaway speed with reliable hands, and as the clear engine of Buffalo's ground game, he carries weekly upside in one of the league's best offenses. 2025: 1621 rush yds, 12 rush TD, 291 rec yds, 2 rec TD, 18.1 FPTS/GM.",
        impact: 'HIGH',
      },
      {
        name: 'DJ Moore',
        position: 'WR',
        archetype: 'HIGH CEILING WR3',
        narrative:
          "Buffalo's splashiest offensive addition, brought in to give Allen a legitimate No. 1 receiver. Moore is a polished route-runner with yards-after-catch ability, though the Bills' run-heavy identity could keep his numbers more steady than spectacular. 2025: 50 rec, 682 yds, 6 TD, 16.0% target share, 9.9 FPTS/GM.",
      },
      {
        name: 'Khalil Shakir',
        position: 'WR',
        archetype: 'LOW UPSIDE WR4',
        narrative:
          "Reliable slot weapon who led Buffalo in receiving yards in 2025 despite the run-heavy offense. Shakir wins with quickness and dependable hands, but Buffalo's passing volume plus DJ Moore's arrival could cap his ceiling even with a stable weekly floor. 2025: 72 rec, 719 yds, 4 TD, 19.8% target share, 10.5 FPTS/GM.",
      },
      {
        name: 'Josh Allen',
        position: 'QB',
        archetype: 'ELITE QB',
        narrative:
          "Perennial MVP-caliber dual-threat who remains the straw that stirs Buffalo's offense, accounting for 39 total touchdowns in 2025. Allen's arm talent and goal-line rushing give him one of the highest floors and ceilings at the position, though the broken foot that required January surgery is worth tracking. 2025: 3668 pass yds, 25 pass TD, 579 rush yds, 14 rush TD, 22.3 FPTS/GM.",
        impact: 'HIGH',
      },
      { name: 'Dalton Kincaid', position: 'TE', archetype: 'UPSIDE/VOLATILE TE', narrative: 'Offers plenty of upside but the consistent volume just isn\'t there.', impact: 'LOW' },
      { name: 'Dawson Knox', position: 'TE', archetype: 'TD-DEPENDENT', narrative: "He's one of Allen's go-to guys in the red zone, but that's about it.", impact: 'LOW' },
      { name: 'Skylar Bell', position: 'WR', archetype: 'MONITOR IN DEEP LEAGUES', narrative: 'Versatile rookie who could get on the field in Year 1. Worth keeping an eye on.', impact: 'LOW' },
      { name: 'Keon Coleman', position: 'WR', archetype: 'OFF THE RADAR', narrative: "After a rocky Year 2, it's tough to see a scenario where Coleman is relevant.", impact: 'LOW' },
    ],
  },
  {
    teamId: 'CAR',
    outlook:
      'Carolina heads into 2026 with real momentum after jumping from five wins to a surprise playoff berth last season. The biggest offensive change comes with Brad Idzik taking over play-calling duties for the first time after Dave Canales handed him the keys. Bryce Young looked far more comfortable in year three, throwing for 3,011 yards and 23 touchdowns, and the Panthers rewarded him with his fifth-year option. Tetairoa McMillan immediately transformed the passing game, topping 1,000 yards while winning Offensive Rookie of the Year. The backfield is far less settled after Rico Dowdle\'s departure, with Chuba Hubbard, Trevor Etienne, and Jonathon Brooks battling for work. First-round tackle Monroe Freeling was added to strengthen the offensive line.',
    bestStacks: ['Tetairoa McMillan + Bryce Young', 'Jalen Coker + Bryce Young'],
    players: [
      {
        name: 'Tetairoa McMillan',
        position: 'WR',
        archetype: 'ALPHA WR',
        narrative:
          "Big-bodied wideout coming off an impressive rookie campaign that earned him Offensive Rookie of the Year honors. McMillan is already Carolina's clear-cut WR1 and Bryce Young's go-to target, and with another year of chemistry plus a new play-caller, his ceiling only climbs in 2026. 2025: 70 rec, 1014 yds, 7 TD, 25.4% target share, 12.6 FPTS/GM.",
        impact: 'HIGH',
      },
      {
        name: 'Bryce Young',
        position: 'QB',
        archetype: 'SUPERFLEX FRINGE QB2',
        narrative:
          "Former No. 1 overall pick who finally took a real step forward in 2025, leading Carolina to a surprise playoff berth and earning a fifth-year option pickup. Young's highs are very high and his lows still pretty low, but the trajectory is undeniably trending up. 2025: 3011 pass yds, 23 pass TD, 216 rush yds, 2 rush TD, 14.7 FPTS/GM.",
      },
      {
        name: 'Jalen Coker',
        position: 'WR',
        archetype: 'UPSIDE DEEP WR',
        narrative:
          "Big-play receiver who came on strong down the stretch in 2025 after missing the season's first six games with a quad injury. Coker finished second on the team in receiving in just 11 games. If he can finally stay healthy, there's genuine breakout upside. 2025: 33 rec, 394 yds, 3 TD, 14.9% target share, 8.2 FPTS/GM.",
      },
      {
        name: 'Chuba Hubbard',
        position: 'RB',
        archetype: 'LOW UPSIDE GRINDER',
        narrative:
          "Hubbard opened 2025 as Carolina's lead back, but injuries and inconsistent play opened the door for Rico Dowdle. He averaged 3.8 yards per carry and scored just once on the ground. Dowdle's departure creates opportunity, but Jonathon Brooks and Trevor Etienne remain legitimate threats for touches. 2025: 511 rush yds, 1 rush TD, 223 rec yds, 3 rec TD, 8.5 FPTS/GM.",
      },
      { name: 'Jonathon Brooks', position: 'RB', archetype: 'INJURY PRONE UPSIDE RB', narrative: 'Can he stay healthy? If so, he has a chance to make an impact.', impact: 'LOW' },
      { name: 'Xavier Legette', position: 'WR', archetype: 'VOLATILE DEEP WR', narrative: 'This might be the last chance for the former first rounder to catch on.', impact: 'LOW' },
      { name: 'Chris Brazzell', position: 'WR', archetype: 'MONITOR IN DEEP LEAGUES', narrative: 'Speedy rookie who could compete for reps right out of the gate.', impact: 'LOW' },
      { name: "Ja'Tavion Sanders", position: 'TE', archetype: 'OFF THE RADAR', narrative: 'Still on the up slope of his development, but has yet to flash much potential.', impact: 'LOW' },
    ],
  },
  {
    teamId: 'CHI',
    outlook:
      'For once, Chicago actually has stability heading into a season. Ben Johnson is back for year two after transforming the offense in his debut campaign, taking the Bears from one of the league\'s worst units to a top-10 group that won the NFC North and a playoff game. Chicago averaged nearly 26 points per game, and the rebuilt offensive line cut sacks allowed from 68 down to just 24. Caleb Williams took a major step forward with nearly 4,000 passing yards and a 27-to-7 TD-to-INT ratio. D\'Andre Swift topped 1,000 rushing yards while Kyle Monangai carved out a role behind him. The biggest offseason shift came with DJ Moore being traded to Buffalo, putting more pressure on Rome Odunze, Luther Burden III, and Colston Loveland to carry the passing game.',
    bestStacks: ['Luther Burden + Caleb Williams', 'Rome Odunze + Caleb Williams', 'Colston Loveland + Caleb Williams'],
    players: [
      {
        name: 'Luther Burden III',
        position: 'WR',
        archetype: 'HIGH CEILING WR2',
        narrative:
          "YAC-monster who flashed in spurts as a rookie before fully breaking out late in the season. With DJ Moore traded to Buffalo, Burden steps into a much bigger role in year two of Ben Johnson's offense, and his explosive ability gives him breakout upside in 2026. 2025: 47 rec, 652 yds, 2 TD, 12.8% target share, 8.5 FPTS/GM.",
      },
      {
        name: 'Rome Odunze',
        position: 'WR',
        archetype: 'HIGH CEILING WR3',
        narrative:
          "Big outside receiver with a chance to take the next step as Chicago's top perimeter target following DJ Moore's trade to Buffalo. Odunze has the size and contested-catch ability, and the added target share should push his ceiling higher. 2025: 44 rec, 661 yds, 6 TD, 22.1% target share, 12.2 FPTS/GM.",
      },
      {
        name: 'Colston Loveland',
        position: 'TE',
        archetype: 'ALPHA TE',
        narrative:
          "Athletic move tight end who flashed breakout traits down the stretch of his rookie year, leading the Bears in receiving yards (713). With DJ Moore gone and a full year in Johnson's system, Loveland has top-five tight end upside. 2025: 58 rec, 713 yds, 6 TD, 16.5% target share, 10.3 FPTS/GM.",
      },
      {
        name: 'Caleb Williams',
        position: 'QB',
        archetype: 'HIGH CEILING QB1',
        narrative:
          "Former No. 1 overall pick who broke out in Year 2 under Ben Johnson, throwing for nearly 4,000 yards with 27 touchdowns and just 7 interceptions while leading Chicago to a playoff win. With another year in the system and full command of the offense, Williams should take another step forward in 2026. 2025: 3942 pass yds, 27 pass TD, 388 rush yds, 3 rush TD, 18.6 FPTS/GM.",
        impact: 'HIGH',
      },
      { name: "D'Andre Swift", position: 'RB', archetype: 'LOW CEILING VETERAN RB', narrative: "He's proven he can carry a lead back workload, but also offers no upside.", impact: 'LOW' },
      { name: 'Kyle Monangai', position: 'RB', archetype: 'HIGH CEILING COMMITTEE RB', narrative: "Enters the season as the No. 2 but he'll have a role and offers upside.", impact: 'LOW' },
      { name: 'Cole Kmet', position: 'TE', archetype: 'OFF THE RADAR', narrative: "Catch and fall down in-line tight end who doesn't offer any fantasy value.", impact: 'LOW' },
      { name: 'Khalif Raymond', position: 'WR', archetype: 'OFF THE RADAR', narrative: 'Depth wide receiver who is unlikely to surface on the fantasy radar.', impact: 'LOW' },
    ],
  },
  {
    teamId: 'CIN',
    outlook:
      "Cincinnati isn't making many changes heading into 2026. Zac Taylor is back despite a third straight season without a playoff appearance, and the offensive staff remains largely intact. Last year's disappointing 6-11 finish can largely be traced back to Joe Burrow's injury, which knocked him out after Week 2 and sidelined him until Week 13. Without him, the offense never came close to its ceiling. The foundation remains strong with Ja'Marr Chase, Tee Higgins, and Chase Brown all locked in as the core of the offense. Cincinnati addressed the interior offensive line through the draft, but questions about depth remain. As has been the case for several years, everything comes down to Burrow's health and whether the Bengals can keep him clean.",
    bestStacks: ["Ja'Marr Chase + Joe Burrow", 'Tee Higgins + Joe Burrow'],
    players: [
      {
        name: "Ja'Marr Chase",
        position: 'WR',
        archetype: 'ELITE WR',
        narrative:
          "Elite No. 1 receiver who still topped 1,400 yards in 2025 despite catching passes from Joe Flacco and Jake Browning for much of the season. Chase combines rare separation, contested-catch ability, and YAC, and with a healthy Burrow back, he's right back in the conversation for the overall WR1. 2025: 125 rec, 1412 yds, 8 TD, 32.3% target share, 19.7 FPTS/GM.",
        impact: 'HIGH',
      },
      {
        name: 'Chase Brown',
        position: 'RB',
        archetype: 'HIGH VOLUME RB',
        narrative:
          "Workhorse three-down back coming off his first 1,000-yard rushing season as the clear lead back. Brown pairs decisive vision with reliable receiving chops, and with Burrow back healthy, his floor should be among the safest at the position. 2025: 1019 rush yds, 6 rush TD, 437 rec yds, 5 rec TD, 16.5 FPTS/GM.",
        impact: 'HIGH',
      },
      {
        name: 'Tee Higgins',
        position: 'WR',
        archetype: 'HIGH CEILING WR2',
        narrative:
          "X-receiver counterpart to Chase who remains one of the league's best No. 2 options when healthy. Higgins still topped 800 yards in 2025 despite the QB carousel, and with Burrow back and a long-term extension secured, his ceiling as a high-end WR2 is firmly intact. 2025: 59 rec, 846 yds, 11 TD, 18.6% target share, 14.0 FPTS/GM.",
      },
      {
        name: 'Joe Burrow',
        position: 'QB',
        archetype: 'FRINGE ELITE QB',
        narrative:
          "Elite, franchise quarterback whose 2025 was wrecked by a Week 2 injury that cost him 10 games. When healthy, Burrow is among the most accurate and prolific passers in the league with arguably the best receiver duo in football, and a clean bill of health alone vaults Cincinnati back into top-five offense territory. 2025: 1809 pass yds, 17 pass TD, 41 rush yds, 17.4 FPTS/GM.",
        impact: 'HIGH',
      },
      { name: 'Andrei Iosivas', position: 'WR', archetype: 'LOW VOLUME DEEP WR', narrative: "The No. 3 WR occasionally pops, but doesn't see consistent volume.", impact: 'LOW' },
      { name: 'Mike Gesicki', position: 'TE', archetype: 'TE STREAMER', narrative: "If you're looking for consistency at TE, Gesicki isn't your guy.", impact: 'LOW' },
      { name: 'Samaje Perine', position: 'RB', archetype: 'DEEP HANDCUFF', narrative: 'If Chase Brown goes down, Perine is the most likely next man up.', impact: 'LOW' },
      { name: 'Jack Endries', position: 'TE', archetype: 'MONITOR IN DEEP LEAGUES', narrative: 'Depth wide receiver who is unlikely to surface on the fantasy radar.', impact: 'LOW' },
    ],
  },
];

main(async () => {
  log.title(`Importing ${TEAMS.length} team profiles (${EDITION})`);
  const result = await writeTeamProfiles({ source: SOURCE, season: SEASON, edition: EDITION, teams: TEAMS });
  log.ok(`${result.written} Evidence rows written`);
  if (result.unresolved.length) {
    log.warn(`${result.unresolved.length} players could not be matched:`);
    for (const u of result.unresolved) log.plain(`    ${u.name} (${u.position}) — ${u.context}`);
  } else {
    log.ok('All players resolved.');
  }
});
