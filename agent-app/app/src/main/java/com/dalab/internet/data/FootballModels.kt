package com.dalab.internet.data

/**
 * Ciyaaraha (football exact-score prediction contests) -- mirrors the
 * /agent/football/... routes in admin-backend-ts football.routes.ts. The
 * server decides deadlines, the candidate (earliest exact score by server
 * time) and every status; this app only shows them and sends the agent's
 * actions. Kept by R8 with the rest of the data package (Gson).
 */
data class FootballTeamRef(val id: String? = null, val name: String = "", val logoUrl: String? = null)

data class FootballCompanyRef(val id: String = "", val name: String = "")

data class FootballScore(val home: Int = 0, val away: Int = 0)

data class FootballCandidate(
    val predictionId: String,
    val customerId: String,
    val customerName: String = "",
    val phoneMasked: String = "",
    val home: Int = 0,
    val away: Int = 0,
    val submittedAt: String? = null,
)

data class FootballWinner(
    val id: String,
    val predictionId: String,
    val customerId: String,
    val customerName: String = "",
    val phone: String = "",
    // winner_confirmed, reward_pending, reward_paid, reward_failed, disputed
    val status: String = "",
    val confirmedAt: String? = null,
    val notifiedAt: String? = null,
    val home: Int = 0,
    val away: Int = 0,
    val predictedAt: String? = null,
)

data class FootballReward(
    val id: String,
    val attemptNo: Int = 0,
    val status: String = "",
    val transactionRef: String? = null,
    val note: String? = null,
    val rewardLabel: String = "",
    val companyId: String = "",
    val recipientPhone: String = "",
    val createdAt: String? = null,
)

data class FootballEvent(
    val action: String = "",
    val actorType: String = "",
    val createdAt: String? = null,
)

/** A contest as the list and the detail return it (detail adds the rest). */
data class FootballContest(
    val id: String,
    val homeTeam: FootballTeamRef = FootballTeamRef(),
    val awayTeam: FootballTeamRef = FootballTeamRef(),
    val league: String = "",
    val kickoffAt: String? = null,
    val predictionsCloseAt: String? = null,
    val rewardLabel: String = "",
    val rewardCompany: FootballCompanyRef = FootballCompanyRef(),
    val imageUrl: String? = null,
    val participants: Int = 0,
    // draft, open, closed, awaiting_result, verification, completed, no_winner, cancelled, disputed
    val status: String = "",
    val displayStatus: String = "",
    val officialScore: FootballScore? = null,
    val serverTime: String? = null,
    val statusReason: String? = null,
    val exactScoreCount: Int? = null,
    val candidate: FootballCandidate? = null,
    val winner: FootballWinner? = null,
    val rewards: List<FootballReward>? = null,
    val events: List<FootballEvent>? = null,
)

data class FootballTeamOption(val id: String, val name: String, val logoUrl: String? = null, val logoImageId: String? = null)

data class FootballImageUploadRequest(val imageBase64: String, val purpose: String)
data class FootballImageUploadResponse(val id: String, val url: String? = null)

data class FootballTeamInput(val name: String, val logoImageId: String? = null)
data class FootballContestCreateRequest(
    val homeTeam: FootballTeamInput,
    val awayTeam: FootballTeamInput,
    val league: String,
    val kickoffAt: String,
    val predictionsCloseAt: String?,
    val rewardLabel: String,
    val rewardCompanyId: String,
    val imageId: String?,
    val publish: Boolean,
)

data class FootballGoalsRequest(val homeGoals: Int, val awayGoals: Int)
data class FootballReasonRequest(val reason: String)
data class FootballPostponeRequest(val kickoffAt: String, val predictionsCloseAt: String?, val reason: String)
data class FootballConfirmWinnerRequest(val predictionId: String)
data class FootballRewardRequest(val status: String, val transactionRef: String? = null, val note: String? = null)

data class FootballPredictionRow(
    val predictionId: String,
    val position: Int = 0,
    val customerId: String = "",
    val customerName: String = "",
    val phoneMasked: String = "",
    val home: Int = 0,
    val away: Int = 0,
    val submittedAt: String? = null,
    val matchesOfficial: Boolean? = null,
    val isCandidate: Boolean = false,
    val isWinner: Boolean = false,
)

/** The Winning Customer card: the server's candidate or the confirmed winner. */
data class FootballWinningCustomer(
    val predictionId: String,
    val customerName: String = "",
    val phoneMasked: String = "",
    val home: Int = 0,
    val away: Int = 0,
    val submittedAt: String? = null,
    val rewardLabel: String = "",
    val provider: String = "",
    val confirmed: Boolean = false,
    val winnerStatus: String? = null,
    // True only while the server would accept Confirm Winner for this prediction.
    val canConfirm: Boolean = false,
)

data class FootballPredictionsPage(
    val total: Int = 0,
    val page: Int = 0,
    val pageSize: Int = 20,
    val officialScore: FootballScore? = null,
    val candidatePredictionId: String? = null,
    val hasResult: Boolean = false,
    val contestStatus: String? = null,
    val winningCustomer: FootballWinningCustomer? = null,
    val items: List<FootballPredictionRow> = emptyList(),
)

data class FootballEnabledResponse(val enabled: Boolean = false)

data class FootballCustomerSummary(val id: String, val name: String = "", val phoneMasked: String = "", val memberSince: String? = null)
data class FootballCustomerPrediction(
    val predictionId: String,
    val contestId: String,
    val match: String = "",
    val league: String = "",
    val kickoffAt: String? = null,
    val home: Int = 0,
    val away: Int = 0,
    val submittedAt: String? = null,
    val contestStatus: String = "",
    val officialScore: FootballScore? = null,
    // won, correct_not_first, lost, pending, cancelled
    val outcome: String = "",
    val rewardStatus: String? = null,
)
data class FootballCustomerReward(val contestId: String, val status: String = "", val transactionRef: String? = null, val rewardLabel: String = "", val createdAt: String? = null)
data class FootballCustomerSearchResponse(
    val customer: FootballCustomerSummary,
    val predictions: List<FootballCustomerPrediction> = emptyList(),
    val rewards: List<FootballCustomerReward> = emptyList(),
)
