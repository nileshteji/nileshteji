#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

const LANGUAGE_COLORS = {
  JavaScript: '#f1e05a',
  TypeScript: '#3178c6',
  Python: '#3572A5',
  Java: '#b07219',
  'C++': '#f34b7d',
  C: '#555555',
  'C#': '#239120',
  Go: '#00ADD8',
  Rust: '#dea584',
  Ruby: '#701516',
  PHP: '#4F5D95',
  Swift: '#F05138',
  Kotlin: '#A97BFF',
  Dart: '#00B4AB',
  Scala: '#c22d40',
  HTML: '#e34c26',
  CSS: '#563d7c',
  SCSS: '#c6538c',
  Shell: '#89e051',
  Vue: '#41b883',
  Svelte: '#ff3e00',
  Lua: '#000080',
  'Jupyter Notebook': '#DA5B0B',
  Default: '#555555'
}

const CACHE_FILE = path.join(__dirname, 'language-colors-cache.json')
const STATS_CACHE_FILE = path.join(__dirname, 'stats-cache.json')
const STATS_CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000
let cachedLanguageColors = null

async function loadLanguageColors() {
  if (cachedLanguageColors) return cachedLanguageColors

  if (fs.existsSync(CACHE_FILE)) {
    try {
      const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'))
      if (Date.now() - cache.timestamp < 24 * 60 * 60 * 1000) {
        cachedLanguageColors = cache.colors
        return cachedLanguageColors
      }
    } catch (e) { /* ignore */ }
  }

  try {
    const response = await fetch('https://raw.githubusercontent.com/github/linguist/master/lib/linguist/languages.yml')
    if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`)
    const languages = yaml.load(await response.text())
    const colors = {}
    for (const [name, config] of Object.entries(languages)) {
      if (config.color) colors[name] = config.color
    }
    cachedLanguageColors = colors
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ timestamp: Date.now(), colors }, null, 2))
    return colors
  } catch (e) {
    return LANGUAGE_COLORS
  }
}

async function loadStatsCache(repoSlug) {
  const sources = []
  if (repoSlug) {
    sources.push({ type: 'remote', url: `https://raw.githubusercontent.com/${repoSlug}/main/stats-cache.json` })
  }
  sources.push({ type: 'local', filePath: STATS_CACHE_FILE })

  for (const source of sources) {
    try {
      if (source.type === 'remote') {
        const response = await fetch(source.url)
        if (!response.ok) continue
        return { cache: await response.json(), source: source.url }
      }
      if (fs.existsSync(source.filePath)) {
        return { cache: JSON.parse(fs.readFileSync(source.filePath, 'utf-8')), source: source.filePath }
      }
    } catch (e) { continue }
  }
  return { cache: null, source: null }
}

function isStatsCacheFresh(cache, lastYear) {
  if (!cache || !cache.timestamp || !cache.throughYear) return false
  if (cache.throughYear !== lastYear) return false
  return (Date.now() - cache.timestamp) <= STATS_CACHE_MAX_AGE
}

function getLanguageColor(name, githubColor, colors) {
  return githubColor || colors[name] || LANGUAGE_COLORS[name] || LANGUAGE_COLORS.Default
}

function formatNumber(num) {
  return num.toLocaleString()
}

async function getGitHubToken() {
  if (process.env.USER_API_TOKEN) return process.env.USER_API_TOKEN
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  try {
    const { execSync } = require('child_process')
    return execSync('gh auth token', { encoding: 'utf-8' }).trim()
  } catch (e) {
    throw new Error('No GitHub token found. Set GITHUB_TOKEN or use gh auth login')
  }
}

async function graphqlQuery(token, query, variables = {}) {
  const maxAttempts = 7
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'readme-stats-generator',
        },
        body: JSON.stringify({ query, variables }),
      })

      if (!response.ok) {
        if (attempt < maxAttempts) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 20000)
          console.log(`  Attempt ${attempt}/${maxAttempts} failed (${response.status}), retrying in ${Math.ceil(delay / 1000)}s...`)
          await new Promise(r => setTimeout(r, delay))
          continue
        }
        throw new Error(`GraphQL HTTP ${response.status}`)
      }

      const data = await response.json()
      if (data.errors) {
        const isTransient = data.errors.some(e => String(e.message || '').includes('Something went wrong') || e.type === 'INTERNAL')
        if (isTransient && attempt < maxAttempts) {
          const delay = Math.min(3000 * Math.pow(2, attempt - 1), 60000)
          console.log(`  Attempt ${attempt}/${maxAttempts} transient error, retrying in ${Math.ceil(delay / 1000)}s...`)
          await new Promise(r => setTimeout(r, delay))
          continue
        }
        throw new Error(`GraphQL Error: ${JSON.stringify(data.errors)}`)
      }
      return data.data
    } catch (err) {
      if (attempt < maxAttempts) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 20000)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      throw err
    }
  }
}

async function fetchUserInfo(token, fromDate, toDate) {
  // Split into two smaller queries to avoid GitHub API timeouts
  const basicInfo = await graphqlQuery(token, `
    query {
      viewer {
        id
        login
        createdAt
        repositories(ownerAffiliations: OWNER, privacy: PUBLIC, first: 1) {
          totalCount
        }
        contributionsCollection { contributionYears }
      }
    }
  `)

  const lastYearInfo = await graphqlQuery(token, `
    query {
      viewer {
        lastYear: contributionsCollection(from: "${fromDate}", to: "${toDate}") {
          totalCommitContributions
          totalIssueContributions
          totalPullRequestContributions
        }
      }
    }
  `)

  return {
    viewer: {
      ...basicInfo.viewer,
      repositories: basicInfo.viewer.repositories,
      lastYear: lastYearInfo.viewer.lastYear
    }
  }
}

async function fetchAllTimeContributions(token, years) {
  let totalCommits = 0, totalIssues = 0, totalPRs = 0
  const yearly = {}
  for (const year of years) {
    const data = await graphqlQuery(token, `
      query {
        viewer {
          contributionsCollection(from: "${year}-01-01T00:00:00Z", to: "${year}-12-31T23:59:59Z") {
            totalCommitContributions totalIssueContributions totalPullRequestContributions
          }
        }
      }
    `)
    const cc = data.viewer.contributionsCollection
    totalCommits += cc.totalCommitContributions
    totalIssues += cc.totalIssueContributions
    totalPRs += cc.totalPullRequestContributions
    yearly[year] = { commits: cc.totalCommitContributions, issues: cc.totalIssueContributions, prs: cc.totalPullRequestContributions }
    console.log(`  ${year}: ${cc.totalCommitContributions} commits, ${cc.totalIssueContributions} issues, ${cc.totalPullRequestContributions} PRs`)
  }
  return { totalCommits, totalIssues, totalPRs, yearly }
}

async function fetchTotalStars(token) {
  let totalStars = 0, cursor = null, hasNextPage = true
  while (hasNextPage) {
    const data = await graphqlQuery(token, `
      query($cursor: String) {
        viewer {
          repositories(first: 100, after: $cursor, ownerAffiliations: OWNER, privacy: PUBLIC) {
            pageInfo { hasNextPage endCursor }
            nodes { stargazerCount }
          }
        }
      }
    `, { cursor })
    const page = data.viewer.repositories
    totalStars += page.nodes.reduce((sum, r) => sum + r.stargazerCount, 0)
    hasNextPage = page.pageInfo.hasNextPage
    cursor = page.pageInfo.endCursor
  }
  return totalStars
}

async function fetchUserReposWithCommits(token, username, userId, since, languageColors) {
  const repos = []
  let cursor = null, hasNextPage = true
  while (hasNextPage) {
    let data
    try {
      data = await graphqlQuery(token, `
        query($username: String!, $cursor: String) {
          user(login: $username) {
            repositories(first: 10, after: $cursor, ownerAffiliations: OWNER, privacy: PUBLIC) {
              pageInfo { hasNextPage endCursor }
              nodes {
                name url
                defaultBranchRef {
                  target { ... on Commit { history(since: "${since.toISOString()}", author: {id: "${userId}"}) { totalCount } } }
                }
                languages(first: 10) { edges { size node { name color } } }
              }
            }
          }
        }
      `, { username, cursor })
    } catch (err) {
      if (/50[234]/.test(String(err.message))) break
      throw err
    }
    for (const repo of data.user.repositories.nodes) {
      const commits = repo.defaultBranchRef?.target?.history?.totalCount || 0
      if (commits > 0) {
        const totalSize = repo.languages.edges.reduce((s, e) => s + e.size, 0)
        repos.push({
          name: repo.name, url: repo.url, commits,
          languages: repo.languages.edges.map(e => ({
            name: e.node.name,
            percentage: totalSize > 0 ? (e.size / totalSize) * 100 : 0,
            color: getLanguageColor(e.node.name, e.node.color, languageColors)
          })),
          additions: 0, deletions: 0
        })
      }
    }
    hasNextPage = data.user.repositories.pageInfo.hasNextPage
    cursor = data.user.repositories.pageInfo.endCursor
    console.log(`Fetched ${repos.length} repos with commits...`)
  }
  return repos
}

async function fetchRepoCommitStats(token, owner, repoName, userId, since) {
  let additions = 0, deletions = 0, cursor = null, hasNextPage = true
  while (hasNextPage) {
    let data
    try {
      data = await graphqlQuery(token, `
        query($owner: String!, $repoName: String!, $cursor: String) {
          repository(owner: $owner, name: $repoName) {
            defaultBranchRef {
              target { ... on Commit {
                history(first: 100, after: $cursor, since: "${since.toISOString()}", author: {id: "${userId}"}) {
                  pageInfo { hasNextPage endCursor }
                  nodes { additions deletions }
                }
              } }
            }
          }
        }
      `, { owner, repoName, cursor })
    } catch (err) {
      if (/50[234]/.test(String(err.message))) break
      throw err
    }
    const history = data.repository?.defaultBranchRef?.target?.history
    if (!history) break
    for (const commit of history.nodes) {
      additions += commit.additions || 0
      deletions += commit.deletions || 0
    }
    hasNextPage = history.pageInfo.hasNextPage
    cursor = history.pageInfo.endCursor
  }
  return { additions, deletions }
}

function calculateTopLanguages(repos, topN, languageColors) {
  const langCommits = {}
  for (const repo of repos) {
    for (const lang of repo.languages) {
      if (!langCommits[lang.name]) langCommits[lang.name] = { name: lang.name, weighted: 0, color: lang.color }
      langCommits[lang.name].weighted += repo.commits * (lang.percentage / 100)
    }
  }
  const sorted = Object.values(langCommits).sort((a, b) => b.weighted - a.weighted).slice(0, topN)
  const total = sorted.reduce((s, l) => s + l.weighted, 0)
  return sorted.map(l => ({
    name: l.name,
    percentage: total > 0 ? Math.round((l.weighted / total) * 100) : 0,
    color: getLanguageColor(l.name, l.color, languageColors)
  }))
}

function generateLanguageBadge(lang) {
  return `![${lang.name}](https://img.shields.io/static/v1?style=flat-square&label=%E2%A0%80&color=555&labelColor=${encodeURIComponent(lang.color)}&message=${encodeURIComponent(`${lang.name} ${lang.percentage}%`)})`
}

function generateAdditionsBadge(n) {
  const f = formatNumber(n)
  return `![+${f}](https://img.shields.io/static/v1?style=plastic&label=&color=brightgreen&message=${encodeURIComponent(`+${f}`)})`
}

function generateDeletionsBadge(n) {
  const f = formatNumber(n)
  return `![-${f}](https://img.shields.io/static/v1?style=plastic&label=&color=red&message=${encodeURIComponent(`-${f}`)})`
}

function processTemplate(template, data) {
  let result = template
  const replacements = {
    'USERNAME': data.username,
    'ACCOUNT_AGE': data.accountAge,
    'TOTAL_COMMITS_LAST_YEAR': formatNumber(data.totalCommitsLastYear),
    'TOTAL_COMMITS_ALL_TIME': typeof data.totalCommitsAllTime === 'number' ? formatNumber(data.totalCommitsAllTime) : data.totalCommitsAllTime,
    'COMMITS': formatNumber(data.totalCommitsLastYear),
    'REPOS_OWNED': formatNumber(data.reposOwned),
    'REPOS_OWNED_ALL_TIME': formatNumber(data.reposOwned),
    'STARS_RECEIVED': formatNumber(data.starsReceived),
    'STARS_ALL_TIME': formatNumber(data.starsReceived),
    'TOTAL_ADDITIONS_LAST_YEAR': generateAdditionsBadge(data.totalAdditionsLastYear),
    'TOTAL_DELETIONS_LAST_YEAR': generateDeletionsBadge(data.totalDeletionsLastYear),
    'TOTAL_ISSUES_ALL_TIME': formatNumber(data.totalIssuesAllTime),
    'TOTAL_PRS_ALL_TIME': formatNumber(data.totalPRsAllTime),
    'TOTAL_ISSUES_LAST_YEAR': formatNumber(data.totalIssuesLastYear),
    'TOTAL_PRS_LAST_YEAR': formatNumber(data.totalPRsLastYear),
    'TOP_LANGUAGES_ROWS': data.topLanguagesRows,
  }
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), value)
  }

  const repoMatch = result.match(/{{\s*REPO_TEMPLATE_START\s*}}([\s\S]*?){{\s*REPO_TEMPLATE_END\s*}}/)
  if (repoMatch) {
    const tpl = repoMatch[1]
    const items = data.topRepos.map(repo => {
      let item = tpl.replace(/^\n/, '')
      item = item.replace(/{{\s*REPO_NAME\s*}}/g, repo.name)
      item = item.replace(/{{\s*REPO_URL\s*}}/g, repo.url)
      item = item.replace(/{{\s*REPO_COMMITS\s*}}/g, formatNumber(repo.commits))
      item = item.replace(/{{\s*REPO_ADDITIONS\s*}}/g, generateAdditionsBadge(repo.additions))
      item = item.replace(/{{\s*REPO_DELETIONS\s*}}/g, generateDeletionsBadge(repo.deletions))
      return item.trimEnd()
    }).join('\n')
    result = result.replace(/{{\s*REPO_TEMPLATE_START\s*}}[\s\S]*?{{\s*REPO_TEMPLATE_END\s*}}/, items)
  }

  return result
}

async function main() {
  console.log('Starting stats generation...')
  const languageColors = await loadLanguageColors()
  const token = await getGitHubToken()

  const oneYearAgo = new Date()
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)
  const fromDate = oneYearAgo.toISOString()
  const toDate = new Date().toISOString()

  const userInfo = await fetchUserInfo(token, fromDate, toDate)
  const viewer = userInfo.viewer
  console.log(`Fetching stats for user: ${viewer.login}`)

  const accountAge = Math.floor((new Date() - new Date(viewer.createdAt)) / (365.25 * 24 * 60 * 60 * 1000))
  const years = viewer.contributionsCollection.contributionYears
  const lastYear = new Date().getFullYear() - 1
  const cacheYear = Math.min(lastYear, 2025)

  const repoSlug = process.env.GITHUB_REPOSITORY
  const { cache: statsCache } = await loadStatsCache(repoSlug)
  const cacheFresh = isStatsCacheFresh(statsCache, cacheYear)

  const yearsToFetch = cacheFresh ? years.filter(y => y > cacheYear) : years
  console.log(`Fetching contributions for years: ${yearsToFetch.join(', ') || 'none (cached)'}`)

  const allTime = yearsToFetch.length > 0
    ? await fetchAllTimeContributions(token, yearsToFetch)
    : { totalCommits: 0, totalIssues: 0, totalPRs: 0, yearly: {} }

  const cachedTotals = cacheFresh ? statsCache.totals : { commits: 0, issues: 0, prs: 0 }
  const totalCommitsAllTime = cachedTotals.commits + allTime.totalCommits
  const totalIssuesAllTime = cachedTotals.issues + allTime.totalIssues
  const totalPRsAllTime = cachedTotals.prs + allTime.totalPRs

  const totalCommitsLastYear = viewer.lastYear.totalCommitContributions
  const totalIssuesLastYear = viewer.lastYear.totalIssueContributions
  const totalPRsLastYear = viewer.lastYear.totalPullRequestContributions

  if (!cacheFresh) {
    const mergedYearly = { ...(cacheFresh ? statsCache.yearly : {}), ...allTime.yearly }
    fs.writeFileSync(STATS_CACHE_FILE, JSON.stringify({
      timestamp: Date.now(),
      throughYear: cacheYear,
      totals: { commits: totalCommitsAllTime, issues: totalIssuesAllTime, prs: totalPRsAllTime },
      yearly: Object.fromEntries(Object.entries(mergedYearly).filter(([y]) => Number(y) <= cacheYear))
    }, null, 2))
    console.log('Stats cache updated')
  }

  const reposWithCommits = await fetchUserReposWithCommits(token, viewer.login, viewer.id, oneYearAgo, languageColors)
  const topLanguages = calculateTopLanguages(reposWithCommits, 5, languageColors)
  console.log(`Top languages: ${topLanguages.map(l => `${l.name} (${l.percentage}%)`).join(', ')}`)

  const topRepos = reposWithCommits.sort((a, b) => b.commits - a.commits).slice(0, 10)

  console.log('Fetching additions/deletions for top repos...')
  let totalAdditionsLastYear = 0, totalDeletionsLastYear = 0
  for (const repo of topRepos) {
    console.log(`  ${repo.name}...`)
    const stats = await fetchRepoCommitStats(token, viewer.login, repo.name, viewer.id, oneYearAgo)
    repo.additions = stats.additions
    repo.deletions = stats.deletions
    totalAdditionsLastYear += stats.additions
    totalDeletionsLastYear += stats.deletions
  }

  const starsReceived = await fetchTotalStars(token)
  console.log(`Total stars: ${starsReceived}`)

  const statsData = {
    username: viewer.login,
    accountAge,
    totalCommitsLastYear, totalCommitsAllTime,
    reposOwned: viewer.repositories.totalCount,
    starsReceived,
    totalAdditionsLastYear, totalDeletionsLastYear,
    totalIssuesAllTime, totalPRsAllTime,
    totalIssuesLastYear, totalPRsLastYear,
    topLanguages,
    topLanguagesRows: (() => {
      const allTimeRows = [
        `📦 **${formatNumber(viewer.repositories.totalCount)}** public repos`,
        `🔥 **${formatNumber(totalCommitsAllTime)}** commits`,
        `📋 **${formatNumber(totalIssuesAllTime)}** issues`,
        `🔀 **${formatNumber(totalPRsAllTime)}** PRs`,
        `⭐ **${formatNumber(starsReceived)}** stars`
      ]
      const lastYearRows = [
        `🔥 **${formatNumber(totalCommitsLastYear)}** commits`,
        `📝 **${formatNumber(totalIssuesLastYear)}** issues`,
        `🔀 **${formatNumber(totalPRsLastYear)}** PRs`,
        `${generateAdditionsBadge(totalAdditionsLastYear)} lines added`,
        `${generateDeletionsBadge(totalDeletionsLastYear)} lines removed`
      ]
      return Array.from({ length: 5 }, (_, i) => {
        const lang = topLanguages[i]
        return `| ${allTimeRows[i]} | ${lastYearRows[i]} | ${lang ? generateLanguageBadge(lang) : ''} |`
      }).join('\n')
    })(),
    topRepos
  }

  const template = fs.readFileSync(path.join(__dirname, 'TEMPLATE.md'), 'utf-8')
  const readme = processTemplate(template, statsData)
  fs.writeFileSync(path.join(__dirname, 'README.md'), readme)
  console.log('README.md generated!')
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
