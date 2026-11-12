package com.dalab.internet.data

import com.google.gson.Gson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Ciyaaraha models read the exact JSON football.routes.ts sends. */
class FootballModelsTest {
    private val gson = Gson()

    @Test fun `agent contest detail parses, including candidate, winner and rewards`() {
        val json = """
        {"id":"c1","homeTeam":{"id":"t1","name":"Arsenal","logoUrl":"/football/images/x"},
         "awayTeam":{"id":"t2","name":"Chelsea","logoUrl":null},"league":"Premier League",
         "kickoffAt":"2026-10-21T15:00:00.000Z","predictionsCloseAt":"2026-10-21T15:00:00.000Z",
         "rewardLabel":"1 GB Internet","rewardCompany":{"id":"hormuud","name":"Hormuud"},"imageUrl":null,
         "participants":3,"status":"completed","displayStatus":"completed","officialScore":{"home":2,"away":1},
         "serverTime":"2026-10-21T18:00:00.000Z","statusReason":null,"exactScoreCount":2,
         "candidate":{"predictionId":"p1","customerId":"cu1","customerName":"Ahmed Ali","phoneMasked":"61****456","home":2,"away":1,"submittedAt":"2026-10-21T10:00:00.000Z"},
         "winner":{"id":"w1","predictionId":"p1","customerId":"cu1","customerName":"Ahmed Ali","phone":"252615123456","status":"reward_failed","confirmedAt":"2026-10-21T18:00:00.000Z","notifiedAt":"2026-10-21T18:00:01.000Z","home":2,"away":1,"predictedAt":"2026-10-21T10:00:00.000Z"},
         "rewards":[{"id":"r1","attemptNo":1,"status":"failed","transactionRef":null,"note":"SIM busy","rewardLabel":"1 GB Internet","companyId":"hormuud","recipientPhone":"252615123456","createdAt":"2026-10-21T18:05:00.000Z"}],
         "events":[{"action":"winner_confirmed","actorType":"agent","actorId":"a1","oldValue":null,"newValue":{"predictionId":"p1"},"createdAt":"2026-10-21T18:00:00.000Z"}]}
        """
        val c = gson.fromJson(json, FootballContest::class.java)
        assertEquals("Arsenal", c.homeTeam.name)
        assertEquals("Hormuud", c.rewardCompany.name)
        assertEquals(2, c.officialScore!!.home)
        assertEquals("p1", c.candidate!!.predictionId)
        assertEquals("252615123456", c.winner!!.phone)
        assertEquals("reward_failed", c.winner?.status)
        assertEquals(1, c.rewards!!.single().attemptNo)
        assertEquals("agent", c.events!!.single().actorType)
    }

    @Test fun `list rows without detail-only fields parse with nulls`() {
        val json = """[{"id":"c2","homeTeam":{"name":"A"},"awayTeam":{"name":"B"},"league":"L","rewardLabel":"1 GB","rewardCompany":{"id":"x","name":"X"},"participants":0,"status":"open","displayStatus":"predictions_open","officialScore":null}]"""
        val rows = gson.fromJson(json, Array<FootballContest>::class.java)
        assertEquals(1, rows.size)
        assertNull(rows[0].officialScore)
        assertNull(rows[0].winner)
        assertNull(rows[0].events)
    }

    @Test fun `prediction search page and customer search parse`() {
        val page = gson.fromJson(
            """{"total":2,"page":0,"pageSize":20,"officialScore":{"home":2,"away":1},"candidatePredictionId":"p1","winner":null,
               "items":[{"predictionId":"p1","position":1,"customerId":"cu1","customerName":"Ahmed Ali","phoneMasked":"61****456","home":2,"away":1,"submittedAt":"2026-10-21T10:00:00.000Z","matchesOfficial":true,"isCandidate":true,"isWinner":false},
                        {"predictionId":"p2","position":2,"customerId":"cu2","customerName":"Sahra","phoneMasked":"61****789","home":2,"away":1,"submittedAt":"2026-10-21T10:05:00.000Z","matchesOfficial":true,"isCandidate":false,"isWinner":false}]}""",
            FootballPredictionsPage::class.java,
        )
        assertEquals(listOf(1, 2), page.items.map { it.position })
        assertNull(page.winningCustomer)

        val withCard = gson.fromJson(
            """{"total":1,"hasResult":true,"contestStatus":"verification","items":[],
               "winningCustomer":{"predictionId":"p1","customerName":"Yaasiin Maxamed Aadan","phoneMasked":"61****777","home":0,"away":0,
                 "submittedAt":"2026-10-21T00:59:00.000Z","rewardLabel":"2 maalin free","provider":"Hormuud","confirmed":false,"winnerStatus":null,"canConfirm":true}}""",
            FootballPredictionsPage::class.java,
        )
        val wc = withCard.winningCustomer!!
        assertEquals("61****777", wc.phoneMasked)
        assertEquals("Hormuud", wc.provider)
        assertTrue(wc.canConfirm)
        assertTrue(withCard.hasResult)
        assertTrue(page.items[0].isCandidate)

        val search = gson.fromJson(
            """{"customer":{"id":"cu1","name":"Ahmed Ali","phoneMasked":"61****456","memberSince":"2026-01-01T00:00:00.000Z"},
               "predictions":[{"predictionId":"p1","contestId":"c1","match":"Arsenal vs Chelsea","league":"PL","kickoffAt":null,"home":2,"away":1,"submittedAt":null,"contestStatus":"completed","officialScore":{"home":2,"away":1},"outcome":"won","rewardStatus":"reward_paid"}],
               "rewards":[{"contestId":"c1","status":"paid","transactionRef":"TX1","rewardLabel":"1 GB","companyId":"hormuud","createdAt":null}]}""",
            FootballCustomerSearchResponse::class.java,
        )
        assertEquals("won", search.predictions.single().outcome)
        assertNotNull(search.rewards.single().transactionRef)
    }
}
