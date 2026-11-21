package com.dalab.internet.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Sign-in phone field: +252 is fixed, the agent types exactly 9 digits. */
class AgentLoginPhoneTest {
    @Test
    fun keepsOnlyNineDigits() {
        assertEquals("610338686", localPhoneInput("610338686"))
        assertEquals("610338686", localPhoneInput("61 033 8686"))
        assertEquals("610338686", localPhoneInput("6103386861234"))
        assertEquals("61033", localPhoneInput("61033"))
        assertEquals("", localPhoneInput("abc"))
    }

    @Test
    fun aPastedCountryCodeOrLeadingZeroIsDropped() {
        assertEquals("610338686", localPhoneInput("+252 610338686"))
        assertEquals("610338686", localPhoneInput("252610338686"))
        assertEquals("610338686", localPhoneInput("00252610338686"))
        assertEquals("610338686", localPhoneInput("0610338686"))
    }

    @Test
    fun onlyExactlyNineDigitsIsValid() {
        assertTrue(isValidLocalPhone("610338686"))
        assertFalse(isValidLocalPhone("61033868"))
        assertFalse(isValidLocalPhone(""))
        assertFalse(isValidLocalPhone("61033868a"))
    }
}
