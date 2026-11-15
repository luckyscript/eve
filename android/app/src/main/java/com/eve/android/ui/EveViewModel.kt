package com.eve.android.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import com.eve.android.data.EveRepository

class EveViewModel(val repository: EveRepository) : ViewModel() {
    val state = repository.state
    companion object {
        fun factory(repo: EveRepository) = object : ViewModelProvider.Factory {
            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                @Suppress("UNCHECKED_CAST")
                return EveViewModel(repo) as T
            }
        }
    }
}
